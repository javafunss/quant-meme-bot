import type { TokenLifecycle } from "../lifecycle/tokenLifecycle.js";
import type { DecisionJournal } from "../observability/journal.js";
import type { Logger } from "../observability/logger.js";
import type { TradeEvent } from "../types/events.js";

const LAMPORTS_PER_SOL = 1_000_000_000;

interface PaperOptions {
  readonly buySol: number;
  readonly takeProfitPct: number;
  readonly stopLossPct: number;
  readonly maxHoldMs: number;
  readonly sweepIntervalMs: number;
}

interface PaperPosition {
  readonly mint: string;
  readonly lifecycle: TokenLifecycle;
  readonly entryPrice: number; // lamports/token
  readonly solSpent: number;
  readonly tokens: number;
  readonly openedAtMs: number;
  lastPrice: number;
  peakPrice: number;
  lastSignature: string;
}

/**
 * Paper 交易引擎（DRY_RUN 专用）：固定规则离场——止盈/止损/超时。
 * 仓位表有界（只装 APPROVED 的 mint），时间止损用 unref 定时器兜底。
 */
export class PaperPortfolio {
  private readonly positions = new Map<string, PaperPosition>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly opts: PaperOptions,
    private readonly journal: DecisionJournal,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {
    this.sweeper = setInterval(() => this.checkTimeStops(), opts.sweepIntervalMs);
    this.sweeper.unref();
  }

  open(mint: string, entryPrice: number, sizeFactor: number, lifecycle: TokenLifecycle): void {
    if (this.positions.has(mint) || entryPrice <= 0) return;
    const solSpent = this.opts.buySol * sizeFactor;
    if (solSpent <= 0) return;

    lifecycle.transition("EXECUTING", "paper open");
    lifecycle.transition("HOLDING");

    this.positions.set(mint, {
      mint,
      lifecycle,
      entryPrice,
      solSpent,
      tokens: (solSpent * LAMPORTS_PER_SOL) / entryPrice,
      openedAtMs: this.now(),
      lastPrice: entryPrice,
      peakPrice: entryPrice,
      lastSignature: "",
    });
    this.journal.record({
      tsMs: this.now(),
      mint,
      signature: "",
      outcome: "PAPER_OPEN",
      score: null,
      gateMode: "PAPER",
      sentiment: "N/A",
      reasons: [`entry ${entryPrice.toExponential(4)} lamports/token, size ${solSpent} SOL`],
      entryPrice,
    });
  }

  onTrade(event: TradeEvent): void {
    const position = this.positions.get(event.mint);
    if (!position || event.tokenAmount <= 0n) return;

    const price = Number(event.solAmountLamports) / Number(event.tokenAmount);
    position.lastPrice = price;
    position.lastSignature = event.signature;
    if (price > position.peakPrice) position.peakPrice = price;

    const changePct = ((price - position.entryPrice) / position.entryPrice) * 100;
    if (changePct >= this.opts.takeProfitPct) {
      this.close(position, price, `take-profit +${changePct.toFixed(1)}%`);
    } else if (changePct <= -this.opts.stopLossPct) {
      this.close(position, price, `stop-loss ${changePct.toFixed(1)}%`);
    }
  }

  checkTimeStops(): void {
    for (const position of this.positions.values()) {
      if (this.now() - position.openedAtMs > this.opts.maxHoldMs) {
        this.close(position, position.lastPrice, "time-stop");
      }
    }
  }

  private close(position: PaperPosition, exitPrice: number, reason: string): void {
    if (!this.positions.delete(position.mint)) return;

    position.lifecycle.transition("CLOSING", reason);
    position.lifecycle.transition("CLOSED");

    const pnlSol = ((exitPrice - position.entryPrice) * position.tokens) / LAMPORTS_PER_SOL;
    this.journal.record({
      tsMs: this.now(),
      mint: position.mint,
      signature: position.lastSignature,
      outcome: "PAPER_CLOSE",
      score: null,
      gateMode: "PAPER",
      sentiment: "N/A",
      reasons: [reason],
      pnlSol,
      holdMs: this.now() - position.openedAtMs,
      entryPrice: position.entryPrice,
      exitPrice,
    });
    this.logger.info(
      { mint: position.mint, pnlSol: pnlSol.toFixed(4), reason },
      "paper position closed",
    );
  }

  get openCount(): number {
    return this.positions.size;
  }

  stop(): void {
    clearInterval(this.sweeper);
  }
}
