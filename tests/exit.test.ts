import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pino } from "pino";

import { TokenLifecycle } from "../src/lifecycle/tokenLifecycle.js";
import { DecisionJournal } from "../src/observability/journal.js";
import type { IExecutor } from "../src/pipeline/ports.js";
import { BasicRiskManager } from "../src/risk/riskManager.js";
import { ExitEngine, type ExitOptions } from "../src/risk/exitEngine.js";
import type { ExecutionResult, TradePlan } from "../src/types/events.js";

const silentLogger = pino({ level: "silent" });

const EXIT_OPTS: ExitOptions = {
  recoveryTargetPct: 80,
  recoverySellPct: 50,
  hardStopPct: 25,
  trailingDrawdownPct: 30,
  maxSlippageBps: 1500,
  emergencyTipLamports: 500_000n,
  maxHoldMs: 600_000,
  sweepIntervalMs: 60_000,
};

class FakeExecutor implements IExecutor {
  calls: TradePlan[] = [];
  landed = true;
  execute(plan: TradePlan): Promise<ExecutionResult> {
    this.calls.push(plan);
    return Promise.resolve({ plan, signature: "sig", landed: this.landed, latencyMs: 10 });
  }
}

async function withExit(
  fn: (ctx: {
    exit: ExitEngine;
    executor: FakeExecutor;
    lifecycle: TokenLifecycle;
    realized: number[];
  }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "exit-"));
  try {
    const journal = new DecisionJournal(join(dir, "j.jsonl"), silentLogger);
    const executor = new FakeExecutor();
    const realized: number[] = [];
    const exit = new ExitEngine({
      executor,
      journal,
      logger: silentLogger,
      opts: EXIT_OPTS,
      recordRealizedPnl: (sol) => realized.push(sol),
    });
    const lifecycle = new TokenLifecycle("mint-x", silentLogger);
    lifecycle.transition("FILTERING");
    lifecycle.transition("APPROVED");
    lifecycle.transition("EXECUTING");
    lifecycle.transition("HOLDING");
    exit.registerPosition("mint-x", 1000, 100_000n, 0.05, lifecycle);
    await fn({ exit, executor, lifecycle, realized });
    exit.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("光速回本：+80% 触发卖出 50%，FSM 进入 PARTIAL_TAKE_PROFIT", async () => {
  await withExit(async ({ exit, executor, lifecycle }) => {
    exit.onPrice("mint-x", 1800, "sig-tp"); // +80%
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(executor.calls.length, 1);
    assert.equal(executor.calls[0]?.tokenAmount, 50_000n); // 100_000 × 50%
    assert.equal(executor.calls[0]?.side, "sell");
    assert.equal(lifecycle.state, "PARTIAL_TAKE_PROFIT");
    assert.equal(exit.openCount, 1); // Free Bag 仍在
  });
});

test("硬止损：-30% 触发全仓平仓，FSM CLOSED，盈亏回报风控", async () => {
  await withExit(async ({ exit, executor, lifecycle, realized }) => {
    exit.onPrice("mint-x", 700, "sig-sl"); // -30%
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(executor.calls[0]?.tokenAmount, 100_000n); // 全仓
    assert.equal(lifecycle.state, "CLOSED");
    assert.equal(exit.openCount, 0);
    assert.equal(realized.length, 1);
  });
});

test("追踪止损：峰值 2000 回撤到 1300（-35%）触发全平", async () => {
  await withExit(async ({ exit, executor, lifecycle }) => {
    exit.onPrice("mint-x", 1500, "s1"); // +50%，未达回本线
    exit.onPrice("mint-x", 2000, "s2"); // 峰值（+100% 会先触发回本，部分卖出）
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(lifecycle.state, "PARTIAL_TAKE_PROFIT");
    exit.onPrice("mint-x", 1300, "s3"); // 距峰值 -35%
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(executor.calls.length, 2);
    assert.equal(executor.calls[1]?.tokenAmount, 50_000n); // 剩余全平
    assert.equal(lifecycle.state, "CLOSED");
  });
});

test("卖出失败（内部已重试 3 次）→ 仓位熔断 FAILED，后续 tick 不再发起卖出", async () => {
  await withExit(async ({ exit, executor, lifecycle }) => {
    executor.landed = false;
    exit.onPrice("mint-x", 700, "sig-fail");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(lifecycle.state, "FAILED");
    assert.equal(exit.openCount, 1); // 冻结，未删除，等人工介入

    exit.onPrice("mint-x", 100, "sig-fail-2");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(executor.calls.length, 1); // 不死循环重试
  });
});

test("并发互斥：同一 tick 重复触发只卖一次", async () => {
  await withExit(async ({ exit, executor }) => {
    exit.onPrice("mint-x", 700, "s1");
    exit.onPrice("mint-x", 700, "s2");
    exit.onPrice("mint-x", 700, "s3");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(executor.calls.length, 1);
  });
});

test("风控闸门：单笔限额缩仓 / 日亏损熔断 / 卖出永远放行", async () => {
  const risk = new BasicRiskManager(
    { maxOpenPositions: 2, maxTradeSol: 0.1, dailyLossLimitSol: 1 },
    () => 0,
    silentLogger,
  );
  const buy: TradePlan = { mint: "m", side: "buy", amountSol: 0.5, maxSlippageBps: 100, tipLamports: 1000n };
  const clamped = await risk.approve(buy);
  assert.equal(clamped.approved, true);
  assert.equal(clamped.adjustedPlan?.amountSol, 0.1);

  risk.recordRealizedPnl(-1.2); // 超过日亏损上限
  const blocked = await risk.approve({ ...buy, amountSol: 0.05 });
  assert.equal(blocked.approved, false);

  const sell = await risk.approve({ mint: "m", side: "sell", amountSol: 0, tokenAmount: 1n, maxSlippageBps: 100, tipLamports: 1000n });
  assert.equal(sell.approved, true);
});

test("对账口径：成交额按触发价而非峰值估算", async () => {
  await withExit(async ({ exit, lifecycle, realized }) => {
    exit.onPrice("mint-x", 2000, "s1"); // 峰值（同时触发回本，50% @ 2000）
    await new Promise((r) => setTimeout(r, 20));
    exit.onPrice("mint-x", 1300, "s2"); // 回撤 -35% 触发追踪止损，剩余 50% @ 1300
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(lifecycle.state, "CLOSED");
    // proceeds = 50_000×2000/1e9 + 50_000×1300/1e9 = 0.1 + 0.065 = 0.165；pnl = 0.165 - 0.05
    assert.ok(Math.abs((realized[0] ?? 0) - 0.115) < 1e-9);
  });
});

test("死币时间止损：无成交 tick 超过 maxHoldMs 也强制全平", async () => {
  const dir = await mkdtemp(join(tmpdir(), "exit-ts-"));
  try {
    let now = 1_000_000;
    const journal = new DecisionJournal(join(dir, "j.jsonl"), silentLogger);
    const executor = new FakeExecutor();
    const exit = new ExitEngine({
      executor,
      journal,
      logger: silentLogger,
      opts: { ...EXIT_OPTS, maxHoldMs: 1000, sweepIntervalMs: 60_000 },
      recordRealizedPnl: () => undefined,
      now: () => now,
    });
    try {
      const lifecycle = new TokenLifecycle("mint-dead", silentLogger);
      lifecycle.transition("FILTERING");
      lifecycle.transition("APPROVED");
      lifecycle.transition("EXECUTING");
      lifecycle.transition("HOLDING");
      exit.registerPosition("mint-dead", 1000, 100_000n, 0.05, lifecycle);

      now += 2000; // 超时且零成交
      exit.checkTimeStops();
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(executor.calls.length, 1);
      assert.equal(executor.calls[0]?.tokenAmount, 100_000n);
      assert.equal(lifecycle.state, "CLOSED");
    } finally {
      exit.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
