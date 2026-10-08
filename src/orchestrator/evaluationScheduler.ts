import type { Logger } from "../observability/logger.js";

interface SchedulerOptions {
  readonly delayMs: number;
  readonly maxPending: number;
}

/**
 * 延迟评估调度器：新币创建后等待动量窗口（MOMENTUM_WINDOW_MS）再触发过滤评估。
 * 防御约束：pending 有界（超限丢弃 + warn），定时器 unref，stop() 全量清理。
 */
export class EvaluationScheduler {
  private readonly pending = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly opts: SchedulerOptions,
    private readonly logger: Logger,
  ) {}

  schedule(mint: string, fire: () => void): boolean {
    if (this.pending.has(mint)) return false;
    if (this.pending.size >= this.opts.maxPending) {
      this.logger.warn({ mint, pending: this.pending.size }, "scheduler full, dropping evaluation");
      return false;
    }
    const timer = setTimeout(() => {
      this.pending.delete(mint);
      fire();
    }, this.opts.delayMs);
    timer.unref();
    this.pending.set(mint, timer);
    return true;
  }

  get size(): number {
    return this.pending.size;
  }

  stop(): void {
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }
}
