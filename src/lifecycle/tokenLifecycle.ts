import type { Logger } from "../observability/logger.js";

export const TOKEN_STATES = [
  "DETECTED",
  "FILTERING",
  "BLOCKED",
  "REJECTED",
  "APPROVED",
  "EXECUTING",
  "HOLDING",
  "PARTIAL_TAKE_PROFIT",
  "CLOSING",
  "CLOSED",
  "FAILED",
] as const;

export type TokenState = (typeof TOKEN_STATES)[number];

/** 合法迁移表：任何表外迁移直接抛错，杜绝状态漂移 */
const TRANSITIONS: Readonly<Record<TokenState, readonly TokenState[]>> = {
  DETECTED: ["FILTERING"],
  FILTERING: ["BLOCKED", "REJECTED", "APPROVED"],
  BLOCKED: ["FILTERING", "CLOSED"], // 宏观闸门重开后允许重新评估
  REJECTED: ["CLOSED"],
  APPROVED: ["EXECUTING", "CLOSED"],
  EXECUTING: ["HOLDING", "FAILED"],
  HOLDING: ["PARTIAL_TAKE_PROFIT", "CLOSING"],
  PARTIAL_TAKE_PROFIT: ["CLOSING"], // Free Bag 持仓，只允许继续离场
  CLOSING: ["CLOSED", "FAILED"],
  FAILED: ["CLOSED"],
  CLOSED: [],
};

export class TokenLifecycle {
  private current: TokenState = "DETECTED";

  constructor(
    readonly mint: string,
    private readonly logger: Logger,
  ) {}

  get state(): TokenState {
    return this.current;
  }

  transition(to: TokenState, reason = ""): void {
    const allowed = TRANSITIONS[this.current];
    if (!allowed.includes(to)) {
      throw new Error(`illegal transition ${this.current} -> ${to} for mint ${this.mint}`);
    }
    const from = this.current;
    this.current = to;
    this.logger.debug({ mint: this.mint, from, to, reason }, "token state transition");
  }
}
