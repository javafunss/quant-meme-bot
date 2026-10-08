import type { Logger } from "../observability/logger.js";
import type { IIntelligenceProvider } from "./ports.js";
import type { GateDecision, MacroSnapshot } from "./types.js";

interface IntelligenceOptions {
  readonly pollIntervalMs: number;
  readonly staleThresholdMs: number;
  readonly gateEnabled: boolean;
  /** true = 数据缺失/陈旧时阻断买入（保守）；false = 降级为 TIGHTEN 放行 */
  readonly failClosed: boolean;
}

const SLEEP_SLICE_MS = 250;
const FAILURE_ESCALATION = 3;

/**
 * 宏观情报服务：独立轮询循环 + 内存快照 + 熔断闸门裁决。
 * 防御约束：轮询循环内部全捕获，绝不向调用方抛出未处理拒绝；
 * currentGate() 是同步内存读，可安全用于 gRPC 高频事件热路径。
 */
export class IntelligenceService {
  private snapshot: MacroSnapshot | null = null;
  private running = false;
  private consecutiveFailures = 0;

  constructor(
    private readonly provider: IIntelligenceProvider,
    private readonly opts: IntelligenceOptions,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
  }

  currentGate(nowMs: number = Date.now()): GateDecision {
    if (!this.opts.gateEnabled) {
      return this.normal("macro gate disabled", this.snapshot, false);
    }
    if (this.snapshot === null) {
      return this.opts.failClosed
        ? this.block("no macro snapshot yet (fail-closed)", null, true)
        : this.tighten("no snapshot, degrade to tighten", null, true);
    }
    const stale = nowMs - this.snapshot.fetchedAtMs > this.opts.staleThresholdMs;
    if (stale) {
      return this.opts.failClosed
        ? this.block(`snapshot stale > ${this.opts.staleThresholdMs}ms (fail-closed)`, this.snapshot, true)
        : this.tighten("snapshot stale, degrade to tighten", this.snapshot, true);
    }

    switch (this.snapshot.sentiment) {
      case "EXTREME_FEAR":
        return this.block("extreme fear / market crash regime", this.snapshot, false);
      case "FEAR":
        return this.tighten("fear regime: thresholds x1.5, size x0.5", this.snapshot, false);
      case "EXTREME_GREED":
        return this.tighten("overheated regime: thresholds x1.25, size x0.75", this.snapshot, false);
      default:
        return this.normal("normal regime", this.snapshot, false);
    }
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        this.snapshot = await this.provider.fetchSnapshot();
        this.consecutiveFailures = 0;
        this.logger.info(
          {
            sentiment: this.snapshot.sentiment,
            btc: this.snapshot.btcChangePct24h,
            sol: this.snapshot.solChangePct24h,
            source: this.snapshot.source,
          },
          "macro snapshot updated",
        );
      } catch (err) {
        this.consecutiveFailures += 1;
        if (this.consecutiveFailures >= FAILURE_ESCALATION) {
          this.logger.error({ err, failures: this.consecutiveFailures }, "macro fetch failing repeatedly");
        } else {
          this.logger.warn({ err, failures: this.consecutiveFailures }, "macro fetch failed");
        }
      }
      await this.interruptibleSleep(this.opts.pollIntervalMs);
    }
    this.logger.info("intelligence loop stopped");
  }

  private async interruptibleSleep(ms: number): Promise<void> {
    let remaining = ms;
    while (this.running && remaining > 0) {
      const slice = Math.min(SLEEP_SLICE_MS, remaining);
      await new Promise((resolve) => setTimeout(resolve, slice));
      remaining -= slice;
    }
  }

  private block(reason: string, snapshot: MacroSnapshot | null, stale: boolean): GateDecision {
    return { mode: "BLOCK_ALL", allowBuys: false, thresholdFactor: 10, sizeFactor: 0, reason, snapshot, stale };
  }

  private tighten(reason: string, snapshot: MacroSnapshot | null, stale: boolean): GateDecision {
    return { mode: "TIGHTEN", allowBuys: true, thresholdFactor: 1.5, sizeFactor: 0.5, reason, snapshot, stale };
  }

  private normal(reason: string, snapshot: MacroSnapshot | null, stale: boolean): GateDecision {
    return { mode: "NORMAL", allowBuys: true, thresholdFactor: 1, sizeFactor: 1, reason, snapshot, stale };
  }
}
