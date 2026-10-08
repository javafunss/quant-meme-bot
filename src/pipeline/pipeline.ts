import { PublicKey } from "@solana/web3.js";

import { computeTipLamports } from "../execution/executor.js";
import { associatedTokenAddress } from "../execution/pumpfunIxBuilder.js";
import type { IRpcClient } from "../execution/rpcClient.js";
import type { FilterChain } from "../filters/filterChain.js";
import type { SkillsHubSnapshotProvider } from "../intelligence/skillsHubProvider.js";
import type { GateDecision } from "../intelligence/types.js";
import type { TokenLifecycle } from "../lifecycle/tokenLifecycle.js";
import type { MomentumTracker } from "../momentum/momentumTracker.js";
import type { DecisionJournal } from "../observability/journal.js";
import type { Logger } from "../observability/logger.js";
import type { MetricsRegistry } from "../observability/metrics.js";
import type { PaperPortfolio } from "../paper/paperPortfolio.js";
import type { IExecutor, IRiskManager } from "./ports.js";
import type { ExitEngine } from "../risk/exitEngine.js";
import type { IngestEvent, TradePlan } from "../types/events.js";

const LAMPORTS_PER_SOL = 1_000_000_000;

export interface LiveDeps {
  readonly risk: IRiskManager;
  readonly executor: IExecutor;
  readonly exit: ExitEngine;
  readonly rpc: IRpcClient;
  readonly payer: PublicKey;
  readonly baseBuySol: number;
  readonly maxSlippageBps: number;
  readonly tipBaseLamports: bigint;
  readonly tipMaxLamports: bigint;
}

/**
 * 事件主管线（Phase 3）：过滤器链评估 → APPROVED 后分流：
 * - DRY_RUN：Paper 引擎模拟开仓；
 * - live：RiskManager 闸门 → Executor（Jito Bundle）→ ExitEngine 接管持仓生命周期。
 */
export class TradingPipeline {
  constructor(
    private readonly deps: {
      readonly logger: Logger;
      readonly filterChain: FilterChain;
      readonly skills: SkillsHubSnapshotProvider;
      readonly momentum: MomentumTracker;
      readonly journal: DecisionJournal;
      readonly paper: PaperPortfolio;
      readonly dryRun: boolean;
      readonly live?: LiveDeps | undefined;
      readonly metrics?: MetricsRegistry | undefined;
    },
  ) {}

  async handleEvent(event: IngestEvent, gate: GateDecision, lifecycle: TokenLifecycle): Promise<void> {
    if (event.kind !== "token_created") return;
    const { logger } = this.deps;
    const { snapshot, stale } = this.deps.skills.current();

    const verdict = await this.deps.filterChain.evaluate({
      event,
      gate,
      skills: snapshot,
      skillsStale: stale,
      momentum: this.deps.momentum.snapshot(event.mint),
    });

    const sentiment = gate.snapshot?.sentiment ?? "UNKNOWN";
    this.deps.metrics?.incCounter("bot_filter_verdict_total", { pass: String(verdict.pass), gateMode: gate.mode });

    if (!verdict.pass) {
      lifecycle.transition("REJECTED", verdict.reasons.join("; "));
      this.deps.journal.record({
        tsMs: Date.now(),
        mint: event.mint,
        signature: event.signature,
        outcome: "REJECTED",
        score: verdict.score,
        gateMode: gate.mode,
        sentiment,
        reasons: verdict.reasons,
      });
      logger.info(
        { mint: event.mint, score: verdict.score.toFixed(1), reasons: verdict.reasons },
        "token rejected by filter chain",
      );
      return;
    }

    lifecycle.transition("APPROVED", `score ${verdict.score.toFixed(1)}`);
    this.deps.journal.record({
      tsMs: Date.now(),
      mint: event.mint,
      signature: event.signature,
      outcome: "APPROVED",
      score: verdict.score,
      gateMode: gate.mode,
      sentiment,
      reasons: verdict.reasons,
    });

    if (this.deps.dryRun || !this.deps.live) {
      this.openPaper(event, gate, lifecycle);
      return;
    }
    await this.openLive(event, gate, lifecycle, verdict.score);
  }

  private openPaper(event: IngestEvent & { kind: "token_created" }, gate: GateDecision, lifecycle: TokenLifecycle): void {
    const price = this.deps.momentum.snapshot(event.mint)?.lastPriceLamportsPerToken;
    if (price === null || price === undefined || price <= 0) {
      this.deps.logger.warn({ mint: event.mint }, "no price in momentum window, skip paper open");
      return;
    }
    this.deps.paper.open(event.mint, price, gate.sizeFactor, lifecycle);
    this.deps.logger.info(
      { mint: event.mint, sizeFactor: gate.sizeFactor },
      "paper buy opened (DRY_RUN)",
    );
  }

  private async openLive(
    event: IngestEvent & { kind: "token_created" },
    gate: GateDecision,
    lifecycle: TokenLifecycle,
    score: number,
  ): Promise<void> {
    const { logger } = this.deps;
    const live = this.deps.live;
    if (!live) return;

    const plan: TradePlan = {
      mint: event.mint,
      side: "buy",
      amountSol: live.baseBuySol * gate.sizeFactor, // 宏观闸门缩仓
      maxSlippageBps: live.maxSlippageBps,
      tipLamports: computeTipLamports(live.tipBaseLamports, live.tipMaxLamports, score / 50), // 评分越高 tip 越激进
    };

    const decision = await live.risk.approve(plan);
    if (!decision.approved) {
      logger.warn({ mint: event.mint, reason: decision.reason }, "rejected by risk manager");
      this.deps.journal.record({
        tsMs: Date.now(),
        mint: event.mint,
        signature: event.signature,
        outcome: "REJECTED",
        score,
        gateMode: gate.mode,
        sentiment: gate.snapshot?.sentiment ?? "UNKNOWN",
        reasons: [`risk: ${decision.reason ?? "rejected"}`],
      });
      lifecycle.transition("CLOSED", decision.reason ?? "risk rejected");
      return;
    }

    lifecycle.transition("EXECUTING", "live buy");
    const result = await live.executor.execute(decision.adjustedPlan ?? plan);

    if (!result.landed) {
      lifecycle.transition("FAILED", "buy not landed");
      lifecycle.transition("CLOSED");
      logger.error({ mint: event.mint, latencyMs: result.latencyMs }, "live buy failed");
      return;
    }

    lifecycle.transition("HOLDING");
    this.deps.journal.record({
      tsMs: Date.now(),
      mint: event.mint,
      signature: result.signature ?? "",
      outcome: "LIVE_OPEN",
      score,
      gateMode: gate.mode,
      sentiment: gate.snapshot?.sentiment ?? "UNKNOWN",
      reasons: [`sol ${(decision.adjustedPlan ?? plan).amountSol}`],
    });

    // 移交 ExitEngine。优先回读 ATA 精确余额对账；读不到降级为动量窗口隐含价格估算
    const finalPlan = decision.adjustedPlan ?? plan;
    const ata = associatedTokenAddress(live.payer, new PublicKey(event.mint));
    const exactTokens = await live.rpc.getTokenAccountBalance(ata.toBase58());
    const price = this.deps.momentum.snapshot(event.mint)?.lastPriceLamportsPerToken;
    if (exactTokens !== null && exactTokens > 0n && price && price > 0) {
      live.exit.registerPosition(event.mint, price, exactTokens, finalPlan.amountSol, lifecycle);
      this.deps.metrics?.incCounter("bot_position_open_total", { basis: "ata-exact" });
    } else if (price && price > 0) {
      const tokens = BigInt(Math.round((finalPlan.amountSol * LAMPORTS_PER_SOL) / price));
      live.exit.registerPosition(event.mint, price, tokens, finalPlan.amountSol, lifecycle);
      this.deps.metrics?.incCounter("bot_position_open_total", { basis: "estimated" });
      logger.warn({ mint: event.mint }, "ATA balance unavailable, position tracked with estimated tokens");
    } else {
      logger.error({ mint: event.mint }, "live position opened but no price reference; exit engine NOT tracking");
    }
    logger.info(
      { mint: event.mint, signature: result.signature, latencyMs: result.latencyMs },
      "live buy landed",
    );
  }
}
