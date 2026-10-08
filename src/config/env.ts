import "dotenv/config";
import { z } from "zod";

const boolFromString = z
  .enum(["true", "false"])
  .transform((v) => v === "true");

/** .env 留空的可选项（如 GEYSER_X_TOKEN=）解析为空串，统一归一为 undefined 再走校验 */
const optionalNonEmpty = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.string().min(1).optional(),
);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),

  // Ingestion
  GEYSER_ENDPOINT: z.string().min(1),
  GEYSER_X_TOKEN: optionalNonEmpty,
  // 第二数据源（多源冗余，先到者胜）
  GEYSER_SECONDARY_ENDPOINT: optionalNonEmpty,
  GEYSER_SECONDARY_X_TOKEN: optionalNonEmpty,

  // External Intelligence — 宏观闸门（Binance 公共 REST）
  BINANCE_REST_BASE: z.string().url().default("https://api.binance.com"),
  INTEL_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(15000),
  INTEL_FETCH_TIMEOUT_MS: z.coerce.number().int().min(500).default(5000),
  INTEL_STALE_THRESHOLD_MS: z.coerce.number().int().min(5000).default(60000),
  MACRO_GATE_ENABLED: boolFromString.default("true"),
  INTEL_FAIL_CLOSED: boolFromString.default("true"),

  // External Intelligence — Skills Hub 旁路快照
  SKILLS_HUB_SNAPSHOT_PATH: z.string().min(1).default("./var/skills-hub-snapshot.json"),
  SKILLS_HUB_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(10000),
  SKILLS_HUB_STALE_THRESHOLD_MS: z.coerce.number().int().min(10000).default(300000),

  // Filter Engine
  FILTER_MIN_SCORE: z.coerce.number().min(0).max(100).default(60),

  // Momentum (Phase 2b)：创建后等待该窗口再评估
  MOMENTUM_WINDOW_MS: z.coerce.number().int().min(500).default(3000),
  MOMENTUM_MIN_BUYS: z.coerce.number().int().min(1).default(5),
  MOMENTUM_MIN_BUYERS: z.coerce.number().int().min(1).default(3),
  MOMENTUM_MIN_SOL_INFLOW: z.coerce.number().min(0).default(1),
  MOMENTUM_TTL_MS: z.coerce.number().int().min(60000).default(1800000),
  SCHEDULER_MAX_PENDING: z.coerce.number().int().min(100).default(5000),

  // Paper Trading (Phase 2b, DRY_RUN 专用)
  PAPER_BUY_SOL: z.coerce.number().min(0.001).default(0.05),
  PAPER_TAKE_PROFIT_PCT: z.coerce.number().min(1).default(50),
  PAPER_STOP_LOSS_PCT: z.coerce.number().min(1).default(30),
  PAPER_MAX_HOLD_MS: z.coerce.number().int().min(10000).default(600000),

  // Lifecycle Registry
  REGISTRY_TTL_MS: z.coerce.number().int().min(60000).default(1800000),
  REGISTRY_SWEEP_INTERVAL_MS: z.coerce.number().int().min(10000).default(60000),

  // Observability
  JOURNAL_PATH: z.string().min(1).default("./var/journal.jsonl"),
  // 0 = 不启动指标端口
  METRICS_PORT: z.coerce.number().int().min(0).default(0),
  TELEGRAM_BOT_TOKEN: optionalNonEmpty,
  TELEGRAM_CHAT_ID: optionalNonEmpty,
  ALERT_MIN_INTERVAL_MS: z.coerce.number().int().min(1000).default(10000),

  // Execution (Phase 3)
  SOLANA_RPC_HTTP: z.string().url(),
  JITO_BLOCK_ENGINE_URL: z.string().url().default("https://mainnet.block-engine.jito.wtf"),
  RPC_TIMEOUT_MS: z.coerce.number().int().min(500).default(4000),
  EXEC_MAX_RETRIES: z.coerce.number().int().min(1).max(5).default(3),
  EXEC_CONFIRM_TIMEOUT_MS: z.coerce.number().int().min(5000).default(30000),
  EXEC_CIRCUIT_BREAKER_THRESHOLD: z.coerce.number().int().min(1).default(3),
  MAX_SLIPPAGE_BPS: z.coerce.number().int().min(1).max(5000).default(1500),
  JITO_TIP_BASE_LAMPORTS: z.coerce.bigint().default(10_000n),
  JITO_TIP_MAX_LAMPORTS: z.coerce.bigint().default(200_000n),
  COMPUTE_UNIT_LIMIT: z.coerce.number().int().min(50_000).default(150_000),
  COMPUTE_UNIT_PRICE_MICRO_LAMPORTS: z.coerce.number().int().min(0).default(50_000),
  LIVE_BUY_SOL: z.coerce.number().min(0.001).default(0.05),

  // Risk Manager (Phase 3)
  RISK_MAX_OPEN_POSITIONS: z.coerce.number().int().min(1).default(5),
  RISK_MAX_TRADE_SOL: z.coerce.number().min(0.001).default(0.1),
  RISK_DAILY_LOSS_LIMIT_SOL: z.coerce.number().min(0.01).default(1),

  // Exit Engine (Phase 3)：光速回本 / 硬止损 / 追踪止损
  EXIT_RECOVERY_TARGET_PCT: z.coerce.number().min(1).default(100),
  EXIT_RECOVERY_SELL_PCT: z.coerce.number().min(1).max(100).default(60),
  EXIT_HARD_STOP_PCT: z.coerce.number().min(1).default(25),
  EXIT_TRAILING_DRAWDOWN_PCT: z.coerce.number().min(1).default(30),
  EXIT_EMERGENCY_TIP_LAMPORTS: z.coerce.bigint().default(500_000n),
  // 死币兜底：超过该持仓时长即使无成交也按最近已知价格强制离场
  EXIT_MAX_HOLD_MS: z.coerce.number().int().min(10000).default(600000),
  EXIT_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1000).default(10000),
  // 私钥只允许经环境变量进入进程，zod 校验通过后立刻冻结，任何模块不得回写
  WALLET_SECRET_KEY: optionalNonEmpty,

  DRY_RUN: boolFromString.default("true"),
});

export type AppConfig = Readonly<z.infer<typeof envSchema>>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`环境变量配置不合法：\n${details}`);
  }
  return Object.freeze(parsed.data);
}
