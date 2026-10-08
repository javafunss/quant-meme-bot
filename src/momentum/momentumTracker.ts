import type { Logger } from "../observability/logger.js";
import type { MomentumSnapshot, TradeEvent } from "../types/events.js";

interface Window {
  createdAtMs: number;
  buys: number;
  sells: number;
  buyers: Set<string>;
  solInflowLamports: bigint;
  lastPriceLamportsPerToken: number | null;
  lastTouchedMs: number;
}

interface TrackerOptions {
  readonly ttlMs: number;
  readonly sweepIntervalMs: number;
  /** 只跟踪已注册（见过创建事件）的 mint，防止全量交易打爆内存 */
  readonly trackUnknownMints: boolean;
}

/**
 * 早期动量跟踪器：按 mint 聚合创建后窗口内的买入笔数/独立买家/SOL 流入。
 * 内存安全：TTL 清扫（unref 定时器），未知 mint 默认不跟踪。
 */
export class MomentumTracker {
  private readonly windows = new Map<string, Window>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly opts: TrackerOptions,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {
    this.sweeper = setInterval(() => this.sweep(), opts.sweepIntervalMs);
    this.sweeper.unref();
  }

  registerCreation(mint: string, createdAtMs: number): void {
    if (!this.windows.has(mint)) {
      this.windows.set(mint, {
        createdAtMs,
        buys: 0,
        sells: 0,
        buyers: new Set(),
        solInflowLamports: 0n,
        lastPriceLamportsPerToken: null,
        lastTouchedMs: this.now(),
      });
    }
  }

  recordTrade(event: TradeEvent): void {
    const window = this.windows.get(event.mint);
    if (!window) {
      if (!this.opts.trackUnknownMints) return;
      this.registerCreation(event.mint, event.detectedAtMs);
      return this.recordTrade(event);
    }

    if (event.side === "buy") {
      window.buys += 1;
      window.buyers.add(event.trader);
      window.solInflowLamports += event.solAmountLamports;
    } else {
      window.sells += 1;
    }
    if (event.tokenAmount > 0n) {
      window.lastPriceLamportsPerToken = Number(event.solAmountLamports) / Number(event.tokenAmount);
    }
    window.lastTouchedMs = this.now();
  }

  snapshot(mint: string): MomentumSnapshot | null {
    const window = this.windows.get(mint);
    if (!window) return null;
    return {
      mint,
      createdAtMs: window.createdAtMs,
      buys: window.buys,
      sells: window.sells,
      uniqueBuyers: window.buyers.size,
      solInflowLamports: window.solInflowLamports,
      lastPriceLamportsPerToken: window.lastPriceLamportsPerToken,
    };
  }

  sweep(): number {
    let evicted = 0;
    for (const [mint, window] of this.windows) {
      if (this.now() - window.lastTouchedMs > this.opts.ttlMs) {
        this.windows.delete(mint);
        evicted += 1;
      }
    }
    if (evicted > 0) {
      this.logger.debug({ evicted, size: this.windows.size }, "momentum tracker swept");
    }
    return evicted;
  }

  get size(): number {
    return this.windows.size;
  }

  stop(): void {
    clearInterval(this.sweeper);
  }
}
