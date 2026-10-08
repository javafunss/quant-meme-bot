import type { Logger } from "../observability/logger.js";
import type { IngestEvent } from "../types/events.js";
import type { EventHandler, IDataSource } from "./ports.js";

/**
 * 多源冗余接入：并发启动 N 个数据源，按 (kind, signature) 去重、先到者胜。
 * 单源崩溃由各自内部重连兜底；全部源都失败才视为致命（throw 交给上层重启策略）。
 */
export class MultiSource implements IDataSource {
  readonly name = "multi-source";
  private readonly seen = new Map<string, number>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly sources: readonly IDataSource[],
    private readonly dedupTtlMs: number,
    private readonly logger: Logger,
  ) {
    if (sources.length === 0) throw new Error("MultiSource requires at least one source");
    this.sweeper = setInterval(() => this.purge(), dedupTtlMs);
    this.sweeper.unref();
  }

  async start(onEvent: EventHandler): Promise<void> {
    const handler: EventHandler = (event) => {
      if (this.isDuplicate(event)) return;
      onEvent(event);
    };
    const results = await Promise.allSettled(this.sources.map((s) => s.start(handler)));
    const rejected = results.filter((r) => r.status === "rejected");
    if (rejected.length === results.length) throw new Error("all ingestion sources failed");
  }

  async stop(): Promise<void> {
    clearInterval(this.sweeper);
    const results = await Promise.allSettled(this.sources.map((s) => s.stop()));
    for (const r of results) {
      if (r.status === "rejected") this.logger.error({ err: r.reason }, "source stop failed");
    }
  }

  private isDuplicate(event: IngestEvent): boolean {
    const key = `${event.kind}:${event.signature}`;
    if (this.seen.has(key)) return true;
    this.seen.set(key, Date.now());
    return false;
  }

  private purge(): void {
    const cutoff = Date.now() - this.dedupTtlMs;
    for (const [key, ts] of this.seen) {
      if (ts < cutoff) this.seen.delete(key);
    }
  }
}
