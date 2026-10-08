import type { TokenLifecycle } from "../lifecycle/tokenLifecycle.js";
import type { IAlerter } from "../observability/alerter.js";
import type { DecisionJournal } from "../observability/journal.js";
import type { Logger } from "../observability/logger.js";
import type { IExecutor } from "../pipeline/ports.js";
import type { TradePlan } from "../types/events.js";

const LAMPORTS_PER_SOL = 1_000_000_000;

export interface ExitOptions {
  /** 光速回本线：涨幅达到该百分比时卖出 recoverySellPct% 仓位 */
  readonly recoveryTargetPct: number;
  readonly recoverySellPct: number;
  /** 硬止损：相对成本价的总亏损阈值 */
  readonly hardStopPct: number;
  /** 追踪止损：从最高点回撤阈值 */
  readonly trailingDrawdownPct: number;
  readonly maxSlippageBps: number;
  readonly emergencyTipLamports: bigint;
  /** 死币兜底：超过该持仓时长即使无成交 tick 也按最近已知价格强制离场 */
  readonly maxHoldMs: number;
  readonly sweepIntervalMs: number;
}

interface LivePosition {
  readonly mint: string;
  readonly lifecycle: TokenLifecycle;
  readonly entryPrice: number; // lamports/token
  readonly openedAtMs: number;
  tokensHeld: bigint;
  readonly solSpentSol: number;
  realizedSol: number;
  peakPrice: number;
  lastPrice: number;
  partialTaken: boolean;
  fused: boolean;
  lastSignature: string;
}

/**
 * 自动化光速回本 + 离场引擎。
 *
 * 并发设计（铁律二）：
 * - 价格 tick 是高频同步回调，卖出是异步——用 inFlightSells 集合做 per-mint 互斥，
 *   保证同一仓位绝不并发双卖（止盈和止损在同一 tick 竞争时只有一个胜出）；
 * - sell 内部 fire-and-forget 但显式 catch；
 * - executor 内部已含 3 次重试，execute 整体失败一次 = 3 次打包失败 → 该仓位立即熔断
 *   （FAILED + fused），红色 error 日志，绝不重试死循环；
 * - 时间止损由独立 sweeper 驱动：死币没有任何成交 tick，onPrice 永远不会被调用，
 *   没有这条兜底仓位会挂死到进程重启。
 */
export class ExitEngine {
  private readonly positions = new Map<string, LivePosition>();
  private readonly inFlightSells = new Set<string>();
  private readonly sweeper: NodeJS.Timeout;
  private readonly now: () => number;

  constructor(
    private readonly deps: {
      readonly executor: IExecutor;
      readonly journal: DecisionJournal;
      readonly logger: Logger;
      readonly opts: ExitOptions;
      readonly recordRealizedPnl: (sol: number) => void;
      readonly alerter?: IAlerter | undefined;
      readonly now?: (() => number) | undefined;
    },
  ) {
    this.now = deps.now ?? Date.now;
    this.sweeper = setInterval(() => this.checkTimeStops(), deps.opts.sweepIntervalMs);
    this.sweeper.unref();
  }

  registerPosition(
    mint: string,
    entryPrice: number,
    tokensHeld: bigint,
    solSpentSol: number,
    lifecycle: TokenLifecycle,
  ): void {
    this.positions.set(mint, {
      mint,
      lifecycle,
      entryPrice,
      openedAtMs: this.now(),
      tokensHeld,
      solSpentSol,
      realizedSol: 0,
      peakPrice: entryPrice,
      lastPrice: entryPrice,
      partialTaken: false,
      fused: false,
      lastSignature: "",
    });
  }

  /** 价格 tick 入口（来自链上 trade 事件）。同步决策、异步执行。 */
  onPrice(mint: string, priceLamportsPerToken: number, signature: string): void {
    const position = this.positions.get(mint);
    if (!position || position.fused || priceLamportsPerToken <= 0) return;
    position.lastSignature = signature;
    position.lastPrice = priceLamportsPerToken;
    if (priceLamportsPerToken > position.peakPrice) position.peakPrice = priceLamportsPerToken;

    const changePct = ((priceLamportsPerToken - position.entryPrice) / position.entryPrice) * 100;
    const drawdownPct = ((priceLamportsPerToken - position.peakPrice) / position.peakPrice) * 100;
    const { opts } = this.deps;

    if (!position.partialTaken && changePct >= opts.recoveryTargetPct) {
      // 光速回本：卖出 recoverySellPct%，剩余即 Free Bag
      const sellTokens = (position.tokensHeld * BigInt(Math.round(opts.recoverySellPct))) / 100n;
      this.fireSell(position, sellTokens, `recovery +${changePct.toFixed(1)}%`, priceLamportsPerToken);
    } else if (changePct <= -opts.hardStopPct) {
      this.fireSell(position, position.tokensHeld, `hard-stop ${changePct.toFixed(1)}%`, priceLamportsPerToken);
    } else if (position.peakPrice > position.entryPrice && drawdownPct <= -opts.trailingDrawdownPct) {
      this.fireSell(position, position.tokensHeld, `trailing-stop ${drawdownPct.toFixed(1)}% from peak`, priceLamportsPerToken);
    }
  }

  /** 死币时间止损：用最近已知价格强制全平 */
  checkTimeStops(): void {
    for (const position of this.positions.values()) {
      if (position.fused) continue;
      if (this.now() - position.openedAtMs > this.deps.opts.maxHoldMs) {
        this.fireSell(position, position.tokensHeld, "time-stop (no liquidity)", position.lastPrice);
      }
    }
  }

  private fireSell(position: LivePosition, tokens: bigint, reason: string, triggerPrice: number): void {
    if (tokens <= 0n) return;
    // per-mint 互斥：并发出货请求直接丢弃
    if (this.inFlightSells.has(position.mint)) return;
    this.inFlightSells.add(position.mint);
    void this.sell(position, tokens, reason, triggerPrice)
      .catch((err: unknown) => {
        this.deps.logger.error({ err, mint: position.mint, reason }, "sell threw unexpectedly");
        this.fusePosition(position, reason);
      })
      .finally(() => this.inFlightSells.delete(position.mint));
  }

  private async sell(position: LivePosition, tokens: bigint, reason: string, triggerPrice: number): Promise<void> {
    const { opts } = this.deps;
    const isPartial = tokens < position.tokensHeld;

    const plan: TradePlan = {
      mint: position.mint,
      side: "sell",
      amountSol: 0,
      tokenAmount: tokens,
      maxSlippageBps: opts.maxSlippageBps,
      tipLamports: opts.emergencyTipLamports, // 离场单用最高 tip，保命优先
    };

    if (!isPartial) position.lifecycle.transition("CLOSING", reason);
    const result = await this.deps.executor.execute(plan);

    if (!result.landed) {
      // execute 内部已重试 maxRetries 次（默认 3 = “连续 3 次打包失败”），到此即熔断
      this.fusePosition(position, reason);
      return;
    }

    // 用触发价估算成交额；精确对账靠 Phase 4b 的成交回报解析（仍偏近似，但不再用峰值自欺）
    const proceedsSol = (Number(tokens) * triggerPrice) / LAMPORTS_PER_SOL;
    position.realizedSol += proceedsSol;
    position.tokensHeld -= tokens;

    if (isPartial) {
      position.partialTaken = true;
      position.lifecycle.transition("PARTIAL_TAKE_PROFIT", reason);
      this.deps.logger.info(
        { mint: position.mint, soldPct: this.deps.opts.recoverySellPct, proceedsSol: proceedsSol.toFixed(4) },
        "RECOVERY sell landed, free bag riding",
      );
    } else {
      position.lifecycle.transition("CLOSED", reason);
      const pnlSol = position.realizedSol - position.solSpentSol;
      this.deps.recordRealizedPnl(pnlSol);
      this.positions.delete(position.mint);
      this.deps.logger.info(
        { mint: position.mint, pnlSol: pnlSol.toFixed(4), reason },
        "position closed",
      );
    }

    this.deps.journal.record({
      tsMs: this.now(),
      mint: position.mint,
      signature: result.signature ?? "",
      outcome: "LIVE_CLOSE",
      score: null,
      gateMode: "LIVE",
      sentiment: "N/A",
      reasons: [reason, `partial=${isPartial}`],
      ...(isPartial ? {} : { pnlSol: position.realizedSol - position.solSpentSol }),
    });
  }

  /** 熔断：FSM 置 FAILED，仓位冻结，红色错误日志 + critical 告警，等待人工介入 */
  private fusePosition(position: LivePosition, reason: string): void {
    position.fused = true;
    try {
      if (position.lifecycle.state === "CLOSING") position.lifecycle.transition("FAILED", reason);
    } catch (err) {
      this.deps.logger.error({ err, mint: position.mint }, "lifecycle transition error during fuse");
    }
    this.deps.journal.record({
      tsMs: this.now(),
      mint: position.mint,
      signature: position.lastSignature,
      outcome: "FUSE",
      score: null,
      gateMode: "LIVE",
      sentiment: "N/A",
      reasons: [`sell failed after internal retries, position frozen: ${reason}`],
    });
    this.deps.logger.error(
      { mint: position.mint, reason, tokensHeld: position.tokensHeld.toString() },
      "EMERGENCY FUSE: sell failed repeatedly (RPC timeout / rug / bundle rejects), manual intervention required",
    );
    this.deps.alerter?.alert("critical", "仓位熔断：卖出连续失败，需要人工介入", {
      mint: position.mint,
      reason,
      tokensHeld: position.tokensHeld.toString(),
    });
  }

  get openCount(): number {
    return this.positions.size;
  }

  stop(): void {
    clearInterval(this.sweeper);
  }
}
