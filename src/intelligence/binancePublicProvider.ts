import { z } from "zod";

import type { IIntelligenceProvider } from "./ports.js";
import type { MacroSnapshot, Sentiment } from "./types.js";

const tickerSchema = z.object({
  symbol: z.string(),
  priceChangePercent: z.string(),
});

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"] as const;
export type TrackedSymbol = (typeof SYMBOLS)[number];

export class BinancePublicProvider implements IIntelligenceProvider {
  readonly name = "binance-public-rest";

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  async fetchSnapshot(signal?: AbortSignal): Promise<MacroSnapshot> {
    // 防御：外层超时 + 外部取消信号合并，任何情况下定时器必须被清理
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("binance api timeout")), this.timeoutMs);
    const onExternalAbort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onExternalAbort);

    try {
      // 元组形式 Promise.all 保留每个位置的类型（noUncheckedIndexedAccess 下数组 map 会丢失）
      const [btc, eth, sol] = await Promise.all([
        this.fetchChangePct("BTCUSDT", controller.signal),
        this.fetchChangePct("ETHUSDT", controller.signal),
        this.fetchChangePct("SOLUSDT", controller.signal),
      ]);
      return {
        sentiment: classifySentiment(btc, eth, sol),
        btcChangePct24h: btc,
        ethChangePct24h: eth,
        solChangePct24h: sol,
        fetchedAtMs: Date.now(),
        source: this.name,
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  private async fetchChangePct(symbol: string, signal: AbortSignal): Promise<number> {
    const res = await fetch(`${this.baseUrl}/api/v3/ticker/24hr?symbol=${symbol}`, { signal });
    if (!res.ok) throw new Error(`binance ${symbol} http ${res.status}`);

    const json: unknown = await res.json();
    const parsed = tickerSchema.safeParse(json);
    if (!parsed.success) throw new Error(`binance ${symbol} malformed payload`);

    const pct = Number(parsed.data.priceChangePercent);
    if (!Number.isFinite(pct)) throw new Error(`binance ${symbol} non-numeric change pct`);
    return pct;
  }
}

/**
 * 情绪分类占位启发式（Phase 2 将被 Skills Hub 多因子打分替代）：
 * 加权 24h 涨跌幅，BTC 0.5 / ETH 0.2 / SOL 0.3。纯函数，可单测。
 */
export function classifySentiment(btc: number, eth: number, sol: number): Sentiment {
  const score = btc * 0.5 + eth * 0.2 + sol * 0.3;
  if (score <= -8) return "EXTREME_FEAR";
  if (score <= -3) return "FEAR";
  if (score < 3) return "NEUTRAL";
  if (score < 8) return "GREED";
  return "EXTREME_GREED";
}
