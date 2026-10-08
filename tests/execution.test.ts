import assert from "node:assert/strict";
import { test } from "node:test";

import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { pino } from "pino";

import {
  applySlippageFloor,
  parseBondingCurve,
  solOutForTokens,
  tokensOutForSol,
  type BondingCurveState,
} from "../src/execution/bondingCurve.js";
import { computeTipLamports, PumpExecutor } from "../src/execution/executor.js";
import { PUMP_GLOBAL } from "../src/execution/pumpfunIxBuilder.js";
import type { IRelay } from "../src/execution/relay.js";
import type { IRpcClient } from "../src/execution/rpcClient.js";
import type { TradePlan } from "../src/types/events.js";

const silentLogger = pino({ level: "silent" });

// ---------- 曲线数学 ----------

const curve: BondingCurveState = {
  virtualTokenReserves: 1_000_000_000_000n,
  virtualSolReserves: 30_000_000_000n,
  realTokenReserves: 900_000_000_000n,
  realSolReserves: 0n,
  tokenTotalSupply: 1_000_000_000_000n,
  complete: false,
};

test("曲线数学：买入含 1% 手续费，滑点下限精确", () => {
  const naive = (curve.virtualTokenReserves * 1_000_000_000n) / (curve.virtualSolReserves + 1_000_000_000n);
  const actual = tokensOutForSol(curve, 1_000_000_000n);
  assert.ok(actual < naive); // 手续费导致成交更少
  assert.ok(actual > 0n);
  assert.equal(applySlippageFloor(1000n, 1500), 850n);
  assert.ok(solOutForTokens(curve, 1_000_000n) > 0n);
});

test("曲线解析：畸形数据返回 null", () => {
  assert.equal(parseBondingCurve(new Uint8Array(10)), null);
});

// ---------- tip ----------

test("动态 tip：按紧急度放大并封顶", () => {
  assert.equal(computeTipLamports(10_000n, 200_000n, 1), 10_000n);
  assert.equal(computeTipLamports(10_000n, 200_000n, 3), 30_000n);
  assert.equal(computeTipLamports(10_000n, 200_000n, 100), 100_000n); // urgency 上限 10
  assert.equal(computeTipLamports(10_000n, 50_000n, 10), 50_000n); // max 封顶
});

// ---------- Executor（Fake RPC / Fake Relay） ----------

function curveBytes(): Uint8Array {
  const b = Buffer.alloc(49);
  b.writeBigUInt64LE(curve.virtualTokenReserves, 8);
  b.writeBigUInt64LE(curve.virtualSolReserves, 16);
  b.writeBigUInt64LE(curve.realTokenReserves, 24);
  b.writeBigUInt64LE(curve.realSolReserves, 32);
  b.writeBigUInt64LE(curve.tokenTotalSupply, 40);
  return new Uint8Array(b);
}

const FEE_RECIPIENT = Keypair.generate().publicKey;

function globalBytes(): Uint8Array {
  const b = new Uint8Array(80);
  b.set(FEE_RECIPIENT.toBuffer(), 41);
  return b;
}

interface FakeRpcBehavior {
  simulateErr?: unknown;
  neverConfirm?: boolean;
  curveMissing?: boolean;
}

function fakeRpc(behavior: FakeRpcBehavior = {}): IRpcClient {
  return {
    getAccountInfo: (pubkey: string) => {
      if (pubkey === PUMP_GLOBAL.toBase58()) return Promise.resolve(globalBytes());
      if (behavior.curveMissing) return Promise.resolve(null);
      return Promise.resolve(curveBytes());
    },
    getLatestBlockhash: () => Promise.resolve(bs58.encode(new Uint8Array(32).fill(1))),
    simulateTransaction: () => Promise.resolve({ err: behavior.simulateErr ?? null, logs: [] }),
    getSignatureStatuses: () =>
      Promise.resolve([behavior.neverConfirm ? null : { confirmationStatus: "confirmed" }]),
    sendTransaction: () => Promise.resolve("rpc-sig"),
    getTokenAccountBalance: () => Promise.resolve(null),
  };
}

function fakeRelay(fail: boolean): IRelay & { sends: number } {
  return {
    name: fail ? "fail-relay" : "ok-relay",
    sends: 0,
    sendSignedTransactions(): Promise<string> {
      this.sends += 1;
      return fail ? Promise.reject(new Error("relay down")) : Promise.resolve("bundle-id");
    },
  };
}

function makeExecutor(behavior: FakeRpcBehavior, relay: IRelay, overrides: Partial<Parameters<typeof PumpExecutor.prototype.execute>[0]> extends never ? never : object = {}) {
  const opts = {
    maxRetries: 2,
    confirmTimeoutMs: 1200,
    computeUnitLimit: 150_000,
    computeUnitPriceMicroLamports: 1000,
    tipMinLamports: 1_000n,
    tipMaxLamports: 10_000n,
    circuitBreakerThreshold: 2,
    ...overrides,
  };
  return new PumpExecutor({
    rpc: fakeRpc(behavior),
    relays: [relay],
    payer: Keypair.generate(),
    logger: silentLogger,
    opts,
  });
}

const MINT = Keypair.generate().publicKey.toBase58();

function buyPlan(): TradePlan {
  return { mint: MINT, side: "buy", amountSol: 0.01, maxSlippageBps: 1500, tipLamports: 5_000n };
}

test("executor：买入全链路成功落地", async () => {
  const relay = fakeRelay(false);
  const executor = makeExecutor({}, relay);
  const result = await executor.execute(buyPlan());
  assert.equal(result.landed, true);
  assert.ok(result.signature);
  assert.equal(relay.sends >= 1, true);
});

test("executor：simulate 预检失败 → 不浪费中继/tip，重试后失败", async () => {
  const relay = fakeRelay(false);
  const executor = makeExecutor({ simulateErr: { InstructionError: [0, "Custom: 1"] } }, relay);
  const result = await executor.execute(buyPlan());
  assert.equal(result.landed, false);
  assert.equal(relay.sends, 0); // 预检拦截，bundle 从未发出
});

test("executor：曲线账户消失（rug）→ 失败计入熔断", async () => {
  const executor = makeExecutor({ curveMissing: true }, fakeRelay(false));
  const result = await executor.execute(buyPlan());
  assert.equal(result.landed, false);
});

test("executor：确认超时 → 有界轮询后失败，不死等", async () => {
  const executor = makeExecutor({ neverConfirm: true }, fakeRelay(false));
  const start = Date.now();
  const result = await executor.execute(buyPlan());
  assert.equal(result.landed, false);
  assert.ok(Date.now() - start < 15_000); // maxRetries × confirmTimeout 上界内
});

test("executor：连续失败达到阈值 → 熔断器打开，后续请求立即拒绝", async () => {
  const relay = fakeRelay(true); // 中继全挂
  const executor = makeExecutor({}, relay);
  await executor.execute(buyPlan());
  const second = await executor.execute(buyPlan());
  assert.equal(second.landed, false);
  assert.equal(executor.isCircuitOpen, true);

  const sendsBefore = relay.sends;
  const third = await executor.execute(buyPlan());
  assert.equal(third.landed, false);
  assert.equal(third.latencyMs, 0); // 熔断后零网络调用
  assert.equal(relay.sends, sendsBefore);
});
