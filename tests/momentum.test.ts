import assert from "node:assert/strict";
import { test } from "node:test";

import { pino } from "pino";

import { EarlyMomentumFilter } from "../src/filters/earlyMomentumFilter.js";
import { MomentumTracker } from "../src/momentum/momentumTracker.js";
import { EvaluationScheduler } from "../src/orchestrator/evaluationScheduler.js";
import type { FilterContext } from "../src/pipeline/ports.js";
import type { TradeEvent } from "../src/types/events.js";

const silentLogger = pino({ level: "silent" });

function trade(mint: string, trader: string, sol: bigint, token: bigint, side: "buy" | "sell" = "buy"): TradeEvent {
  return {
    kind: "trade",
    slot: 1n,
    signature: `sig-${trader}`,
    mint,
    side,
    trader,
    tokenAmount: token,
    solAmountLamports: sol,
    detectedAtMs: Date.now(),
  };
}

test("momentum tracker：聚合计数/独立买家/流入/隐含价格", () => {
  const tracker = new MomentumTracker(
    { ttlMs: 60_000, sweepIntervalMs: 60_000, trackUnknownMints: false },
    silentLogger,
  );
  try {
    tracker.registerCreation("mint-1", Date.now());
    tracker.recordTrade(trade("mint-1", "alice", 1_000_000_000n, 1_000_000n));
    tracker.recordTrade(trade("mint-1", "bob", 2_000_000_000n, 1_000_000n));
    tracker.recordTrade(trade("mint-1", "alice", 500_000_000n, 500_000n, "sell"));
    tracker.recordTrade(trade("unknown-mint", "eve", 1n, 1n)); // 未注册 mint 不跟踪

    const snap = tracker.snapshot("mint-1");
    assert.ok(snap);
    assert.equal(snap.buys, 2);
    assert.equal(snap.sells, 1);
    assert.equal(snap.uniqueBuyers, 2);
    assert.equal(snap.solInflowLamports, 3_000_000_000n);
    assert.equal(snap.lastPriceLamportsPerToken, 1000);
    assert.equal(tracker.snapshot("unknown-mint"), null);
  } finally {
    tracker.stop();
  }
});

test("momentum filter：零买入否决，达标满分", async () => {
  const filter = new EarlyMomentumFilter({ minBuys: 5, minBuyers: 3, minSolInflowSol: 1 });
  const tracker = new MomentumTracker(
    { ttlMs: 60_000, sweepIntervalMs: 60_000, trackUnknownMints: false },
    silentLogger,
  );
  try {
    tracker.registerCreation("dead-mint", Date.now());
    const ctxDead = { momentum: tracker.snapshot("dead-mint") } as FilterContext;
    const dead = await filter.evaluate(ctxDead);
    assert.equal(dead.pass, false);

    tracker.registerCreation("hot-mint", Date.now());
    for (const t of ["a", "b", "c", "d", "e"]) {
      tracker.recordTrade(trade("hot-mint", t, 500_000_000n, 1_000_000n));
    }
    const ctxHot = { momentum: tracker.snapshot("hot-mint") } as FilterContext;
    const hot = await filter.evaluate(ctxHot);
    assert.equal(hot.pass, true);
    assert.equal(hot.score, 100); // 5/5 买家 5/3 流入 2.5/1 全部达标
  } finally {
    tracker.stop();
  }
});

test("evaluation scheduler：延迟触发 + 容量上限丢弃 + stop 清理", async () => {
  const scheduler = new EvaluationScheduler({ delayMs: 30, maxPending: 2 }, silentLogger);
  let fired = 0;

  assert.equal(scheduler.schedule("a", () => { fired += 1; }), true);
  assert.equal(scheduler.schedule("a", () => { fired += 1; }), false); // 重复
  assert.equal(scheduler.schedule("b", () => { fired += 1; }), true);
  assert.equal(scheduler.schedule("c", () => { fired += 1; }), false); // 超限

  await new Promise((r) => setTimeout(r, 80));
  assert.equal(fired, 2);
  assert.equal(scheduler.size, 0);

  scheduler.schedule("d", () => { fired += 1; });
  scheduler.stop();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(fired, 2); // stop 后不再触发
});
