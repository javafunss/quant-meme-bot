import type { Logger } from "../observability/logger.js";
import { TokenLifecycle, type TokenState } from "./tokenLifecycle.js";

const TERMINAL_STATES: ReadonlySet<TokenState> = new Set(["CLOSED", "REJECTED", "FAILED"]);

interface Entry {
  lifecycle: TokenLifecycle;
  lastTouchedMs: number;
}

interface RegistryOptions {
  readonly ttlMs: number;
  readonly sweepIntervalMs: number;
}

/**
 * mint → TokenLifecycle 注册表。
 * 内存安全：定时清扫超龄条目（终态静默淘汰；非终态超龄记 warn 后淘汰，
 * 因为单事件流程必然在当次落定，超龄非终态只可能是异常残留）。
 */
export class LifecycleRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly opts: RegistryOptions,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {
    this.sweeper = setInterval(() => this.sweep(), opts.sweepIntervalMs);
    this.sweeper.unref(); // 不允许清扫器阻止进程退出
  }

  getOrCreate(mint: string): { lifecycle: TokenLifecycle; created: boolean } {
    const existing = this.entries.get(mint);
    if (existing) {
      existing.lastTouchedMs = this.now();
      return { lifecycle: existing.lifecycle, created: false };
    }
    const lifecycle = new TokenLifecycle(mint, this.logger);
    this.entries.set(mint, { lifecycle, lastTouchedMs: this.now() });
    return { lifecycle, created: true };
  }

  sweep(): number {
    let evicted = 0;
    for (const [mint, entry] of this.entries) {
      if (this.now() - entry.lastTouchedMs <= this.opts.ttlMs) continue;
      if (!TERMINAL_STATES.has(entry.lifecycle.state)) {
        this.logger.warn({ mint, state: entry.lifecycle.state }, "evicting stale non-terminal lifecycle");
      }
      this.entries.delete(mint);
      evicted += 1;
    }
    if (evicted > 0) {
      this.logger.info({ evicted, size: this.entries.size }, "lifecycle registry swept");
    }
    return evicted;
  }

  get size(): number {
    return this.entries.size;
  }

  stop(): void {
    clearInterval(this.sweeper);
  }
}
