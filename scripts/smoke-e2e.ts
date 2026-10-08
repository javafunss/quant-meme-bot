import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pino } from "pino";

import { CreatorDenylistFilter } from "../src/filters/creatorDenylistFilter.js";
import { EarlyMomentumFilter } from "../src/filters/earlyMomentumFilter.js";
import { EventSanityFilter } from "../src/filters/eventSanityFilter.js";
import { FilterChain } from "../src/filters/filterChain.js";
import { NarrativeHeatFilter } from "../src/filters/narrativeHeatFilter.js";
import type { IDataSource, EventHandler } from "../src/ingestion/ports.js";
import { IntelligenceService } from "../src/intelligence/intelligenceService.js";
import { SkillsHubSnapshotProvider } from "../src/intelligence/skillsHubProvider.js";
import type { MacroSnapshot } from "../src/intelligence/types.js";
import { LifecycleRegistry } from "../src/lifecycle/lifecycleRegistry.js";
import { MomentumTracker } from "../src/momentum/momentumTracker.js";
import { DecisionJournal, type JournalEntry } from "../src/observability/journal.js";
import { BotController } from "../src/orchestrator/botController.js";
import { EvaluationScheduler } from "../src/orchestrator/evaluationScheduler.js";
import { PaperPortfolio } from "../src/paper/paperPortfolio.js";
import { TradingPipeline } from "../src/pipeline/pipeline.js";
import type { TradeEvent } from "../src/types/events.js";

const logger = pino({ level: "warn" });
const dir = await mkdtemp(join(tmpdir(), "smoke-"));
const MINT = "smoke-mint";

class FakeSource implements IDataSource {
  readonly name = "fake";
  constructor(private readonly emit: (h: EventHandler) => void) {}
  start(onEvent: EventHandler): Promise<void> {
    this.emit(onEvent);
    return new Promise(() => undefined);
  }
  stop(): Promise<void> {
    return Promise.resolve();
  }
}

function buy(trader: string, solLamports: bigint, tokenAmount: bigint): TradeEvent {
  return {
    kind: "trade",
    slot: 200n,
    signature: `buy-${trader}`,
    mint: MINT,
    side: "buy",
    trader,
    tokenAmount,
    solAmountLamports: solLamports,
    detectedAtMs: Date.now(),
  };
}

const fakeSnapshot: MacroSnapshot = {
  sentiment: "NEUTRAL",
  btcChangePct24h: 0,
  ethChangePct24h: 0,
  solChangePct24h: 0,
  fetchedAtMs: Date.now(),
  source: "fake",
};

const intel = new IntelligenceService(
  { name: "fake", fetchSnapshot: () => Promise.resolve(fakeSnapshot) },
  { pollIntervalMs: 60_000, staleThresholdMs: 60_000, gateEnabled: true, failClosed: true },
  logger,
);
(intel as unknown as { snapshot: MacroSnapshot }).snapshot = fakeSnapshot;

const skills = new SkillsHubSnapshotProvider(
  { path: join(dir, "skills.json"), pollIntervalMs: 60_000, staleThresholdMs: 60_000 },
  logger,
);
const chain = new FilterChain(
  [
    new EventSanityFilter(),
    new CreatorDenylistFilter(),
    new NarrativeHeatFilter(),
    new EarlyMomentumFilter({ minBuys: 5, minBuyers: 3, minSolInflowSol: 1 }),
  ],
  { minScore: 60 },
  logger,
);
const registry = new LifecycleRegistry({ ttlMs: 60_000, sweepIntervalMs: 60_000 }, logger);
const momentum = new MomentumTracker(
  { ttlMs: 60_000, sweepIntervalMs: 60_000, trackUnknownMints: false },
  logger,
);
const scheduler = new EvaluationScheduler({ delayMs: 200, maxPending: 100 }, logger);
const journal = new DecisionJournal(join(dir, "journal.jsonl"), logger);
const paper = new PaperPortfolio(
  { buySol: 0.05, takeProfitPct: 50, stopLossPct: 30, maxHoldMs: 60_000, sweepIntervalMs: 10_000 },
  journal,
  logger,
);
const pipeline = new TradingPipeline({ logger, filterChain: chain, skills, momentum, journal, paper, dryRun: true });

let controller: BotController;
const source = new FakeSource((emit) => {
  setTimeout(() => {
    emit({
      kind: "token_created", slot: 100n, signature: "create-1", mint: MINT,
      bondingCurve: null, creator: "smoke-creator", detectedAtMs: Date.now(),
    });
    emit({
      kind: "token_created", slot: 101n, signature: "create-dup", mint: MINT,
      bondingCurve: null, creator: "smoke-creator", detectedAtMs: Date.now(),
    });
    // 动量窗口内 5 个独立买家，价格 500 lamports/token
    for (const t of ["a", "b", "c", "d", "e"]) emit(buy(t, 500_000_000n, 1_000_000n));
  }, 100);
  setTimeout(() => {
    // +60% 价格成交 → 触发止盈
    emit(buy("whale", 800_000_000n, 1_000_000n));
  }, 600);
  setTimeout(() => {
    void controller.stop().then(async () => {
      const lines = (await readFile(join(dir, "journal.jsonl"), "utf8"))
        .trim().split("\n").filter(Boolean)
        .map((l) => JSON.parse(l) as JournalEntry);
      const outcomes = lines.map((l) => l.outcome).join(",");
      const close = lines.find((l) => l.outcome === "PAPER_CLOSE");
      const pnlOk = close?.pnlSol !== undefined && Math.abs(close.pnlSol - 0.03) < 1e-9;
      console.log(`OUTCOMES=${outcomes}`);
      console.log(`PNL_SOL=${close?.pnlSol}`);
      console.log(outcomes === "APPROVED,PAPER_OPEN,PAPER_CLOSE" && pnlOk ? "SMOKE_OK" : "SMOKE_FAIL");
      process.exit(0);
    });
  }, 1000);
});

controller = new BotController({ logger, source, intel, skills, registry, momentum, scheduler, journal, pipeline, paper });
await controller.start();

process.on("exit", () => void rm(dir, { recursive: true, force: true }).catch(() => undefined));
