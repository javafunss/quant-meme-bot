export type Sentiment = "EXTREME_FEAR" | "FEAR" | "NEUTRAL" | "GREED" | "EXTREME_GREED";

/** 宏观情报快照。CEX 慢变量，只用于 regime 判定与阈值缩放，绝不进入单笔决策热路径 */
export interface MacroSnapshot {
  readonly sentiment: Sentiment;
  readonly btcChangePct24h: number;
  readonly ethChangePct24h: number;
  readonly solChangePct24h: number;
  readonly fetchedAtMs: number;
  readonly source: string;
}

export type GateMode = "NORMAL" | "TIGHTEN" | "BLOCK_ALL";

/** 宏观熔断闸门裁决。allowBuys=false 时任何买入计划必须在状态机层面被拦截 */
export interface GateDecision {
  readonly mode: GateMode;
  readonly allowBuys: boolean;
  /** >1 表示过滤门槛收紧倍率（Phase 2 过滤器消费） */
  readonly thresholdFactor: number;
  /** <1 表示仓位缩减倍率（Phase 3 风控消费） */
  readonly sizeFactor: number;
  readonly reason: string;
  readonly snapshot: MacroSnapshot | null;
  readonly stale: boolean;
}
