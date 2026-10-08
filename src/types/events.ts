export type PubkeyStr = string; // base58

/** Phase 1：新币创建事件（Pump.fun program 的 create 指令） */
export interface TokenCreatedEvent {
  readonly kind: "token_created";
  readonly slot: bigint;
  readonly signature: string;
  readonly mint: PubkeyStr;
  readonly bondingCurve: PubkeyStr | null;
  readonly creator: PubkeyStr | null;
  /** 本地检测时间戳，用于端到端延迟测量 */
  readonly detectedAtMs: number;
}

/** Phase 2b：Pump.fun 买卖事件（buy/sell 指令，数据来自 Anchor 指令解析） */
export interface TradeEvent {
  readonly kind: "trade";
  readonly slot: bigint;
  readonly signature: string;
  readonly mint: PubkeyStr;
  readonly side: "buy" | "sell";
  readonly trader: PubkeyStr;
  /** buy=获得的 token 数量；sell=卖出的 token 数量（原始最小单位） */
  readonly tokenAmount: bigint;
  /** buy=maxSolCost 上界；sell=minSolOutput 下界（精确成交额需余额差分，Phase 3 曲线状态落地后替换） */
  readonly solAmountLamports: bigint;
  readonly detectedAtMs: number;
}

export type IngestEvent = TokenCreatedEvent | TradeEvent;

/** 创建后早期动量窗口快照（MomentumTracker 产出） */
export interface MomentumSnapshot {
  readonly mint: PubkeyStr;
  readonly createdAtMs: number;
  readonly buys: number;
  readonly sells: number;
  readonly uniqueBuyers: number;
  readonly solInflowLamports: bigint;
  /** 最近一笔成交的隐含价格（lamports/token），来自指令参数推算，仅供参考 */
  readonly lastPriceLamportsPerToken: number | null;
}

/** Skills Hub 旁路快照中的单条趋势代币（由 agent/MCP 定时产出，BOT 只读） */
export interface TrendingMint {
  readonly mint: PubkeyStr;
  readonly symbol: string | null;
  /** 叙事热度 0-100 */
  readonly narrativeHeat: number;
  readonly smartMoneyNetInflowSol: number | null;
  readonly source: string;
}

/** Skills Hub 旁路快照：热搜榜 / 聪明钱 / dev 黑名单 / 热点叙事 */
export interface SkillsHubSnapshot {
  readonly fetchedAtMs: number;
  readonly trendingMints: readonly TrendingMint[];
  readonly denylistedCreators: readonly PubkeyStr[];
  readonly hotTopics: readonly string[];
}

export interface FilterVerdict {
  readonly pass: boolean;
  readonly score: number;
  readonly reasons: readonly string[];
}

export interface TradePlan {
  readonly mint: PubkeyStr;
  readonly side: "buy" | "sell";
  readonly amountSol: number;
  /** side=sell 时必填：卖出 token 数量（原始最小单位） */
  readonly tokenAmount?: bigint;
  readonly maxSlippageBps: number;
  readonly tipLamports: bigint;
}

export interface RiskDecision {
  readonly approved: boolean;
  readonly reason?: string;
  readonly adjustedPlan?: TradePlan;
}

export interface ExecutionResult {
  readonly plan: TradePlan;
  readonly signature: string | null;
  readonly landed: boolean;
  readonly latencyMs: number;
}
