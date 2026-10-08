import type { Logger } from "./logger.js";

export type AlertLevel = "warn" | "critical";

export interface IAlerter {
  alert(level: AlertLevel, message: string, context?: Record<string, unknown>): void;
}

/** 无外部通道时的兜底：告警降级为日志（critical → error 级，日志管线会标红） */
export class NoopAlerter implements IAlerter {
  constructor(private readonly logger: Logger) {}

  alert(level: AlertLevel, message: string, context?: Record<string, unknown>): void {
    if (level === "critical") this.logger.error({ ...context }, `ALERT: ${message}`);
    else this.logger.warn({ ...context }, `ALERT: ${message}`);
  }
}

interface TelegramOptions {
  readonly botToken: string;
  readonly chatId: string;
  readonly minIntervalMs: number;
  readonly timeoutMs: number;
}

/**
 * Telegram 告警。防御设计：
 * - fire-and-forget + 显式 catch：告警通道故障绝不允许影响交易主循环；
 * - warn 级按 minIntervalMs 限流（风暴期防刷屏），critical 级（熔断/FUSE）绕过限流必发；
 * - 每次发送独立 AbortController 超时。
 */
export class TelegramAlerter implements IAlerter {
  private lastWarnSentMs = 0;
  private droppedWarns = 0;

  constructor(
    private readonly opts: TelegramOptions,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  alert(level: AlertLevel, message: string, context?: Record<string, unknown>): void {
    if (level === "warn") {
      const now = Date.now();
      if (now - this.lastWarnSentMs < this.opts.minIntervalMs) {
        this.droppedWarns += 1;
        return;
      }
      this.lastWarnSentMs = now;
    }
    const dropped = this.droppedWarns;
    this.droppedWarns = 0;
    void this.send(level, message, context, dropped).catch((err: unknown) => {
      this.logger.error({ err }, "telegram alert failed");
    });
  }

  private async send(
    level: AlertLevel,
    message: string,
    context: Record<string, unknown> | undefined,
    droppedWarns: number,
  ): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("telegram timeout")), this.opts.timeoutMs);
    try {
      const ctxText = context ? `\n${JSON.stringify(context)}` : "";
      const droppedText = droppedWarns > 0 ? `\n(期间另有 ${droppedWarns} 条 warn 被限流)` : "";
      const res = await this.fetchImpl(`https://api.telegram.org/bot${this.opts.botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: this.opts.chatId,
          text: `[${level.toUpperCase()}] ${message}${ctxText}${droppedText}`,
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`telegram http ${res.status}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
