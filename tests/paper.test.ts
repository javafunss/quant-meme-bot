import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pino } from "pino";

import { TokenLifecycle } from "../src/lifecycle/tokenLifecycle.js";
import { DecisionJournal, type JournalEntry } from "../src/observability/journal.js";
import { PaperPortfolio } from "../src/paper/paperPortfolio.js";
import type { TradeEvent } from "../src/types/events.js";

const silentLogger = pino({ level: "silent" });

function trade(mint: string, solLamports: bigint, tokenAmount: bigint): TradeEvent {
  return {
    kind: "trade",
    slot: 1n,
    signature: `sig-${solLamports}`,
    mint,
    side: "buy",
    trader: "someone",
    tokenAmount,
    solAmountLamports: solLamports,
    detectedAtMs: Date.now(),
  };
}

async function withPortfolio(
  opts: { takeProfitPct: number; stopLossPct: number; maxHoldMs: number },
  fn: (paper: PaperPortfolio, readEntries: () => Promise<JournalEntry[]>) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "paper-"));
  const journalPath = join(dir, "journal.jsonl");
  const journal = new DecisionJournal(journalPath, silentLogger);
  const paper = new PaperPortfolio(
    { buySol: 0.05, sweepIntervalMs: 60_000, ...opts },
    journal,
    silentLogger,
  );
  const readEntries = async (): Promise<JournalEntry[]> => {
    await journal.flush();
    return (await readFile(journalPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as JournalEntry);
  };
  try {
    await fn(paper, readEntries);
  } finally {
    paper.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

test("paper：止盈平仓，PnL 与 FSM 终态正确", async () => {
  await withPortfolio({ takeProfitPct: 50, stopLossPct: 30, maxHoldMs: 600_000 }, async (paper, readEntries) => {
    const lifecycle = new TokenLifecycle("mint-tp", silentLogger);
    lifecycle.transition("FILTERING");
    lifecycle.transition("APPROVED");

    paper.open("mint-tp", 1000, 1, lifecycle); // 1000 lamports/token
    assert.equal(lifecycle.state, "HOLDING");

    paper.onTrade(trade("mint-tp", 1600n, 1n)); // +60% → 止盈
    assert.equal(lifecycle.state, "CLOSED");
    assert.equal(paper.openCount, 0);

    const entries = await readEntries();
    const close = entries.find((e) => e.outcome === "PAPER_CLOSE");
    assert.ok(close);
    assert.match(close.reasons[0] ?? "", /take-profit/);
    // 0.05 SOL 开仓 → 50_000 tokens；盈利 = (1600-1000) × 50_000 / 1e9 = 0.03 SOL
    assert.ok(Math.abs((close.pnlSol ?? 0) - 0.03) < 1e-9);
  });
});

test("paper：止损与时间止损", async () => {
  await withPortfolio({ takeProfitPct: 50, stopLossPct: 30, maxHoldMs: 100 }, async (paper, readEntries) => {
    const lc1 = new TokenLifecycle("mint-sl", silentLogger);
    lc1.transition("FILTERING");
    lc1.transition("APPROVED");
    paper.open("mint-sl", 1000, 1, lc1);
    paper.onTrade(trade("mint-sl", 600n, 1n)); // -40% → 止损
    const entries1 = await readEntries();
    assert.ok(entries1.find((e) => e.outcome === "PAPER_CLOSE" && /stop-loss/.test(e.reasons[0] ?? "")));

    const lc2 = new TokenLifecycle("mint-ts", silentLogger);
    lc2.transition("FILTERING");
    lc2.transition("APPROVED");
    paper.open("mint-ts", 1000, 1, lc2);
    await new Promise((r) => setTimeout(r, 120));
    paper.checkTimeStops();
    const entries2 = await readEntries();
    assert.ok(entries2.find((e) => e.outcome === "PAPER_CLOSE" && /time-stop/.test(e.reasons[0] ?? "")));
  });
});
