import type { IDataSource } from "../ingestion/ports.js";
import type { IntelligenceService } from "../intelligence/intelligenceService.js";
import type { SkillsHubSnapshotProvider } from "../intelligence/skillsHubProvider.js";
import type { LifecycleRegistry } from "../lifecycle/lifecycleRegistry.js";
import type { TokenLifecycle } from "../lifecycle/tokenLifecycle.js";
import type { MomentumTracker } from "../momentum/momentumTracker.js";
import type { DecisionJournal } from "../observability/journal.js";
import type { Logger } from "../observability/logger.js";
import type { MetricsRegistry } from "../observability/metrics.js";
import type { PaperPortfolio } from "../paper/paperPortfolio.js";
import type { TradingPipeline } from "../pipeline/pipeline.js";
import type { ExitEngine } from "../risk/exitEngine.js";
import type { IngestEvent, TokenCreatedEvent, TradeEvent } from "../types/events.js";
import type { EvaluationScheduler } from "./evaluationScheduler.js";

/**
 * 核心编排控制器（Phase 2b）：
 * - token_created：注册 → 宏观闸门 → 调度延迟评估（等待动量窗口），触发时二次闸门复核；
 * - trade：动量跟踪 + Paper 仓位盯市（止盈/止损）；
 * - 全部异步路径显式 catch，杜绝未捕获拒绝。
 */
export class BotController {
  constructor(
    private readonly deps: {
      readonly logger: Logger;
      readonly source: IDataSource;
      readonly intel: IntelligenceService;
      readonly skills: SkillsHubSnapshotProvider;
      readonly registry: LifecycleRegistry;
      readonly momentum: MomentumTracker;
      readonly scheduler: EvaluationScheduler;
      readonly journal: DecisionJournal;
      readonly pipeline: TradingPipeline;
      readonly paper: PaperPortfolio;
      readonly liveExit?: ExitEngine | undefined;
      readonly metrics?: MetricsRegistry | undefined;
    },
  ) {}

  async start(): Promise<void> {
    this.deps.intel.start();
    this.deps.skills.start();
    this.deps.logger.info("bot controller started: gRPC + macro intel + skills-hub + momentum");
    await this.deps.source.start((event) => this.onEvent(event));
  }

  async stop(): Promise<void> {
    this.deps.skills.stop();
    this.deps.registry.stop();
    this.deps.momentum.stop();
    this.deps.scheduler.stop();
    this.deps.paper.stop();
    this.deps.liveExit?.stop();
    const results = await Promise.allSettled([
      Promise.resolve(this.deps.intel.stop()),
      this.deps.source.stop(),
      this.deps.journal.flush(),
    ]);
    for (const r of results) {
      if (r.status === "rejected") {
        this.deps.logger.error({ err: r.reason }, "error during component shutdown");
      }
    }
  }

  private onEvent(event: IngestEvent): void {
    this.deps.metrics?.incCounter("bot_ingest_events_total", { kind: event.kind });
    if (event.kind === "trade") {
      this.onTrade(event);
      return;
    }
    this.onTokenCreated(event);
  }

  private onTrade(event: TradeEvent): void {
    this.deps.momentum.recordTrade(event);
    this.deps.paper.onTrade(event);
    // 实盘持仓盯市：止盈/止损决策同步完成，卖出动作异步发起（ExitEngine 内部 per-mint 互斥）
    if (this.deps.liveExit && event.tokenAmount > 0n) {
      const price = Number(event.solAmountLamports) / Number(event.tokenAmount);
      this.deps.liveExit.onPrice(event.mint, price, event.signature);
    }
  }

  private onTokenCreated(event: TokenCreatedEvent): void {
    const { logger } = this.deps;
    const { lifecycle, created } = this.deps.registry.getOrCreate(event.mint);
    if (!created) {
      logger.debug({ mint: event.mint }, "duplicate event, skipping");
      return;
    }
    this.deps.momentum.registerCreation(event.mint, event.detectedAtMs);
    lifecycle.transition("FILTERING");

    if (!this.deps.intel.currentGate().allowBuys) {
      this.block(event.mint, event.signature, lifecycle);
      return;
    }

    this.deps.scheduler.schedule(event.mint, () => {
      // 动量窗口结束时宏观闸门可能已变化，必须二次复核
      const gate = this.deps.intel.currentGate();
      if (!gate.allowBuys) {
        this.block(event.mint, event.signature, lifecycle);
        return;
      }
      void this.deps.pipeline.handleEvent(event, gate, lifecycle).catch((err: unknown) => {
        logger.error({ err, mint: event.mint }, "pipeline handleEvent failed");
      });
    });
  }

  private block(mint: string, signature: string, lifecycle: TokenLifecycle): void {
    const gate = this.deps.intel.currentGate();
    lifecycle.transition("BLOCKED", gate.reason);
    this.deps.metrics?.incCounter("bot_blocked_total", { gateMode: gate.mode });
    this.deps.journal.record({
      tsMs: Date.now(),
      mint,
      signature,
      outcome: "BLOCKED",
      score: null,
      gateMode: gate.mode,
      sentiment: gate.snapshot?.sentiment ?? "UNKNOWN",
      reasons: [gate.reason],
    });
    this.deps.logger.warn(
      { mint, signature, gateMode: gate.mode, stale: gate.stale, reason: gate.reason },
      "BUY BLOCKED by macro circuit breaker",
    );
  }
}
