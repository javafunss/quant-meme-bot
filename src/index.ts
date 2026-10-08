import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

import { loadConfig, type AppConfig } from "./config/env.js";
import { PumpExecutor } from "./execution/executor.js";
import { JitoRelay, RpcRelay, type IRelay } from "./execution/relay.js";
import { SolanaRpcClient } from "./execution/rpcClient.js";
import { CreatorDenylistFilter } from "./filters/creatorDenylistFilter.js";
import { EarlyMomentumFilter } from "./filters/earlyMomentumFilter.js";
import { EventSanityFilter } from "./filters/eventSanityFilter.js";
import { FilterChain } from "./filters/filterChain.js";
import { NarrativeHeatFilter } from "./filters/narrativeHeatFilter.js";
import { MultiSource } from "./ingestion/multiSource.js";
import type { IDataSource } from "./ingestion/ports.js";
import { YellowstoneSource } from "./ingestion/yellowstoneSource.js";
import { BinancePublicProvider } from "./intelligence/binancePublicProvider.js";
import { IntelligenceService } from "./intelligence/intelligenceService.js";
import { SkillsHubSnapshotProvider } from "./intelligence/skillsHubProvider.js";
import { LifecycleRegistry } from "./lifecycle/lifecycleRegistry.js";
import { MomentumTracker } from "./momentum/momentumTracker.js";
import { NoopAlerter, TelegramAlerter, type IAlerter } from "./observability/alerter.js";
import { DecisionJournal } from "./observability/journal.js";
import { createLogger, type Logger } from "./observability/logger.js";
import { MetricsRegistry, startMetricsServer } from "./observability/metrics.js";
import { BotController } from "./orchestrator/botController.js";
import { EvaluationScheduler } from "./orchestrator/evaluationScheduler.js";
import { PaperPortfolio } from "./paper/paperPortfolio.js";
import { TradingPipeline, type LiveDeps } from "./pipeline/pipeline.js";
import { ExitEngine } from "./risk/exitEngine.js";
import { BasicRiskManager } from "./risk/riskManager.js";

/** 零信任：live 模式必须注入私钥，且只在内存中还原为 Keypair，绝不落盘、绝不打印 */
function buildLiveDeps(
  config: AppConfig,
  logger: Logger,
  journal: DecisionJournal,
  metrics: MetricsRegistry,
  alerter: IAlerter,
): LiveDeps & { exit: ExitEngine } {
  if (!config.WALLET_SECRET_KEY) {
    throw new Error("DRY_RUN=false 必须通过环境变量提供 WALLET_SECRET_KEY");
  }
  const payer = Keypair.fromSecretKey(bs58.decode(config.WALLET_SECRET_KEY));
  const rpc = new SolanaRpcClient(config.SOLANA_RPC_HTTP, config.RPC_TIMEOUT_MS, logger);
  const relays: IRelay[] = [
    new JitoRelay(config.JITO_BLOCK_ENGINE_URL, config.RPC_TIMEOUT_MS),
    new RpcRelay(rpc), // 兜底直连；可继续追加 bloXroute / Astralane
  ];
  const executor = new PumpExecutor({
    rpc,
    relays,
    payer,
    logger,
    metrics,
    alerter,
    opts: {
      maxRetries: config.EXEC_MAX_RETRIES,
      confirmTimeoutMs: config.EXEC_CONFIRM_TIMEOUT_MS,
      computeUnitLimit: config.COMPUTE_UNIT_LIMIT,
      computeUnitPriceMicroLamports: config.COMPUTE_UNIT_PRICE_MICRO_LAMPORTS,
      tipMinLamports: config.JITO_TIP_BASE_LAMPORTS,
      tipMaxLamports: config.JITO_TIP_MAX_LAMPORTS,
      circuitBreakerThreshold: config.EXEC_CIRCUIT_BREAKER_THRESHOLD,
    },
  });
  const exit = new ExitEngine({
    executor,
    journal,
    logger,
    alerter,
    opts: {
      recoveryTargetPct: config.EXIT_RECOVERY_TARGET_PCT,
      recoverySellPct: config.EXIT_RECOVERY_SELL_PCT,
      hardStopPct: config.EXIT_HARD_STOP_PCT,
      trailingDrawdownPct: config.EXIT_TRAILING_DRAWDOWN_PCT,
      maxSlippageBps: config.MAX_SLIPPAGE_BPS,
      emergencyTipLamports: config.EXIT_EMERGENCY_TIP_LAMPORTS,
      maxHoldMs: config.EXIT_MAX_HOLD_MS,
      sweepIntervalMs: config.EXIT_SWEEP_INTERVAL_MS,
    },
    recordRealizedPnl: (sol) => risk.recordRealizedPnl(sol),
  });
  const risk = new BasicRiskManager(
    {
      maxOpenPositions: config.RISK_MAX_OPEN_POSITIONS,
      maxTradeSol: config.RISK_MAX_TRADE_SOL,
      dailyLossLimitSol: config.RISK_DAILY_LOSS_LIMIT_SOL,
    },
    () => exit.openCount,
    logger,
  );
  return {
    risk,
    executor,
    exit,
    rpc,
    payer: payer.publicKey,
    baseBuySol: config.LIVE_BUY_SOL,
    maxSlippageBps: config.MAX_SLIPPAGE_BPS,
    tipBaseLamports: config.JITO_TIP_BASE_LAMPORTS,
    tipMaxLamports: config.JITO_TIP_MAX_LAMPORTS,
  };
}

function buildSource(config: AppConfig, logger: Logger): IDataSource {
  const primary = new YellowstoneSource(
    { endpoint: config.GEYSER_ENDPOINT, token: config.GEYSER_X_TOKEN },
    logger,
  );
  if (!config.GEYSER_SECONDARY_ENDPOINT) return primary;
  const secondary = new YellowstoneSource(
    { endpoint: config.GEYSER_SECONDARY_ENDPOINT, token: config.GEYSER_SECONDARY_X_TOKEN },
    logger,
  );
  return new MultiSource([primary, secondary], 60_000, logger);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);

  const metrics = new MetricsRegistry();
  const metricsServer =
    config.METRICS_PORT > 0 ? startMetricsServer(metrics, config.METRICS_PORT, logger) : null;
  const alerter: IAlerter =
    config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID
      ? new TelegramAlerter(
          {
            botToken: config.TELEGRAM_BOT_TOKEN,
            chatId: config.TELEGRAM_CHAT_ID,
            minIntervalMs: config.ALERT_MIN_INTERVAL_MS,
            timeoutMs: config.INTEL_FETCH_TIMEOUT_MS,
          },
          logger,
        )
      : new NoopAlerter(logger);

  const source = buildSource(config, logger);
  const intel = new IntelligenceService(
    new BinancePublicProvider(config.BINANCE_REST_BASE, config.INTEL_FETCH_TIMEOUT_MS),
    {
      pollIntervalMs: config.INTEL_POLL_INTERVAL_MS,
      staleThresholdMs: config.INTEL_STALE_THRESHOLD_MS,
      gateEnabled: config.MACRO_GATE_ENABLED,
      failClosed: config.INTEL_FAIL_CLOSED,
    },
    logger,
  );
  const skills = new SkillsHubSnapshotProvider(
    {
      path: config.SKILLS_HUB_SNAPSHOT_PATH,
      pollIntervalMs: config.SKILLS_HUB_POLL_INTERVAL_MS,
      staleThresholdMs: config.SKILLS_HUB_STALE_THRESHOLD_MS,
    },
    logger,
  );
  const filterChain = new FilterChain(
    [
      new EventSanityFilter(),
      new CreatorDenylistFilter(),
      new NarrativeHeatFilter(),
      new EarlyMomentumFilter({
        minBuys: config.MOMENTUM_MIN_BUYS,
        minBuyers: config.MOMENTUM_MIN_BUYERS,
        minSolInflowSol: config.MOMENTUM_MIN_SOL_INFLOW,
      }),
    ],
    { minScore: config.FILTER_MIN_SCORE },
    logger,
  );
  const registry = new LifecycleRegistry(
    { ttlMs: config.REGISTRY_TTL_MS, sweepIntervalMs: config.REGISTRY_SWEEP_INTERVAL_MS },
    logger,
  );
  const momentum = new MomentumTracker(
    {
      ttlMs: config.MOMENTUM_TTL_MS,
      sweepIntervalMs: config.REGISTRY_SWEEP_INTERVAL_MS,
      trackUnknownMints: false,
    },
    logger,
  );
  const scheduler = new EvaluationScheduler(
    { delayMs: config.MOMENTUM_WINDOW_MS, maxPending: config.SCHEDULER_MAX_PENDING },
    logger,
  );
  const journal = new DecisionJournal(config.JOURNAL_PATH, logger);
  const paper = new PaperPortfolio(
    {
      buySol: config.PAPER_BUY_SOL,
      takeProfitPct: config.PAPER_TAKE_PROFIT_PCT,
      stopLossPct: config.PAPER_STOP_LOSS_PCT,
      maxHoldMs: config.PAPER_MAX_HOLD_MS,
      sweepIntervalMs: 10_000,
    },
    journal,
    logger,
  );

  const live = config.DRY_RUN ? undefined : buildLiveDeps(config, logger, journal, metrics, alerter);
  const pipeline = new TradingPipeline({
    logger,
    filterChain,
    skills,
    momentum,
    journal,
    paper,
    dryRun: config.DRY_RUN,
    live,
    metrics,
  });
  const controller = new BotController({
    logger,
    source,
    intel,
    skills,
    registry,
    momentum,
    scheduler,
    journal,
    pipeline,
    paper,
    liveExit: live?.exit,
    metrics,
  });

  const shutdown = (sig: string): void => {
    logger.info({ sig }, "shutting down");
    controller
      .stop()
      .then(() => metricsServer?.stop())
      .catch((err: unknown) => logger.error({ err }, "error during shutdown"))
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  logger.info(
    {
      dryRun: config.DRY_RUN,
      gateEnabled: config.MACRO_GATE_ENABLED,
      minScore: config.FILTER_MIN_SCORE,
      metricsPort: config.METRICS_PORT,
      multiSource: Boolean(config.GEYSER_SECONDARY_ENDPOINT),
    },
    config.DRY_RUN
      ? "quant-meme-bot starting (DRY_RUN: paper trading)"
      : "quant-meme-bot starting (LIVE: Jito bundle execution)",
  );
  await controller.start();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
