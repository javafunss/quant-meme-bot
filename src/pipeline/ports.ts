import type { GateDecision } from "../intelligence/types.js";
import type {
  ExecutionResult,
  FilterVerdict,
  MomentumSnapshot,
  RiskDecision,
  SkillsHubSnapshot,
  TokenCreatedEvent,
  TradePlan,
} from "../types/events.js";

/** 过滤器评估上下文：仅 token_created 事件进入过滤链（trade 事件由动量/仓位模块消费） */
export interface FilterContext {
  readonly event: TokenCreatedEvent;
  readonly gate: GateDecision;
  readonly skills: SkillsHubSnapshot | null;
  readonly skillsStale: boolean;
  readonly momentum: MomentumSnapshot | null;
}

/**
 * Phase 2：组合式过滤器。保持纯函数语义——无网络、无写副作用，只允许读内存快照。
 * score 归一化到 0-100；pass=false 是一票否决（veto），score 参与加权聚合。
 */
export interface IFilter {
  readonly name: string;
  readonly weight: number;
  evaluate(ctx: FilterContext): Promise<FilterVerdict>;
}

/** Phase 3：执行器。实现方负责 bundle 构造、多中继竞速与滑点保护。 */
export interface IExecutor {
  execute(plan: TradePlan): Promise<ExecutionResult>;
}

/** Phase 3/4：风控闸门。任何资金动作前必须经其批准。 */
export interface IRiskManager {
  approve(plan: TradePlan): Promise<RiskDecision>;
}
