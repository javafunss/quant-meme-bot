import type { Logger } from "../observability/logger.js";
import type { IRiskManager } from "../pipeline/ports.js";
import type { RiskDecision, TradePlan } from "../types/events.js";

export interface RiskOptions {
  readonly maxOpenPositions: number;
  readonly maxTradeSol: number;
  readonly dailyLossLimitSol: number;
}

/**
 * 风控闸门：买入需过三道闸——持仓数上限 / 单笔限额（超限额自动缩仓而非拒绝）/ 日亏损熔断。
 * 卖出永远放行（离场不受限）。
 */
export class BasicRiskManager implements IRiskManager {
  private realizedTodaySol = 0;
  private dayStamp = currentDayStamp();

  constructor(
    private readonly opts: RiskOptions,
    private readonly openPositionCount: () => number,
    private readonly logger: Logger,
  ) {}

  approve(plan: TradePlan): Promise<RiskDecision> {
    this.rolloverDayIfNeeded();

    if (plan.side === "sell") return Promise.resolve({ approved: true });

    if (this.realizedTodaySol <= -this.opts.dailyLossLimitSol) {
      return Promise.resolve({
        approved: false,
        reason: `daily loss limit hit (${this.realizedTodaySol.toFixed(3)} SOL)`,
      });
    }
    if (this.openPositionCount() >= this.opts.maxOpenPositions) {
      return Promise.resolve({ approved: false, reason: "max open positions reached" });
    }
    if (plan.amountSol > this.opts.maxTradeSol) {
      this.logger.warn({ mint: plan.mint, from: plan.amountSol, to: this.opts.maxTradeSol }, "trade size clamped");
      return Promise.resolve({
        approved: true,
        reason: "size clamped to per-trade cap",
        adjustedPlan: { ...plan, amountSol: this.opts.maxTradeSol },
      });
    }
    return Promise.resolve({ approved: true });
  }

  /** 由 ExitEngine 在平掉仓位后回报已实现盈亏，驱动日亏损熔断 */
  recordRealizedPnl(sol: number): void {
    this.rolloverDayIfNeeded();
    this.realizedTodaySol += sol;
  }

  private rolloverDayIfNeeded(): void {
    const today = currentDayStamp();
    if (today !== this.dayStamp) {
      this.dayStamp = today;
      this.realizedTodaySol = 0;
      this.logger.info("daily loss counter reset");
    }
  }
}

function currentDayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}
