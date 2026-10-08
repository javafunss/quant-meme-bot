import assert from "node:assert/strict";
import { test } from "node:test";

import bs58 from "bs58";

import { decodeTrade, PUMP_PROGRAM_ID, type RawSubscribeTransaction } from "../src/ingestion/pumpfunDecoder.js";

const BUY_DISC = Buffer.from("66063d1201daebea", "hex");
const SELL_DISC = Buffer.from("33e685a4017f83ad", "hex");

function key(seed: number): Uint8Array {
  return new Uint8Array(32).fill(seed);
}

function rawTrade(discriminator: Buffer, tokenAmount: bigint, solAmount: bigint): RawSubscribeTransaction {
  const data = new Uint8Array(24);
  data.set(discriminator, 0);
  const view = new DataView(data.buffer);
  view.setBigUint64(8, tokenAmount, true);
  view.setBigUint64(16, solAmount, true);

  const accountKeys = Array.from({ length: 14 }, (_, i) => key(i + 1));
  accountKeys[2] = key(0xaa); // mint
  accountKeys[6] = key(0xbb); // trader
  // 指令引用的 programIdIndex 指向 pump program
  const pumpIndex = 13;
  accountKeys[pumpIndex] = bs58.decode(PUMP_PROGRAM_ID);

  return {
    slot: "42",
    transaction: {
      signature: new Uint8Array(64).fill(7),
      transaction: {
        message: {
          accountKeys,
          instructions: [{ programIdIndex: pumpIndex, data }],
        },
      },
      meta: { err: null, logMessages: [] },
    },
  };
}

test("decodeTrade：buy 指令字段完整解析", () => {
  const event = decodeTrade(rawTrade(BUY_DISC, 1_000_000n, 50_000_000n));
  assert.ok(event);
  assert.equal(event.kind, "trade");
  assert.equal(event.side, "buy");
  assert.equal(event.mint, bs58.encode(key(0xaa)));
  assert.equal(event.trader, bs58.encode(key(0xbb)));
  assert.equal(event.tokenAmount, 1_000_000n);
  assert.equal(event.solAmountLamports, 50_000_000n);
  assert.equal(event.slot, 42n);
});

test("decodeTrade：sell 指令识别", () => {
  const event = decodeTrade(rawTrade(SELL_DISC, 500n, 10n));
  assert.equal(event?.side, "sell");
});

test("decodeTrade：失败交易/非 pump 指令返回 null", () => {
  const failed = rawTrade(BUY_DISC, 1n, 1n);
  assert.equal(decodeTrade({ ...failed, transaction: { ...failed.transaction, meta: { err: { code: 1 } } } }), null);

  const noIx: RawSubscribeTransaction = { slot: "1", transaction: { transaction: { message: { accountKeys: [], instructions: [] } }, meta: {} } };
  assert.equal(decodeTrade(noIx), null);
});

test("decodeTrade：多指令交易跳过非买卖指令仍解出 buy", () => {
  const raw = rawTrade(BUY_DISC, 1_000n, 2_000n);
  const message = raw.transaction?.transaction?.message;
  assert.ok(message);
  // 首条是同程序的 create 指令（判别器不匹配），buy 在第二条
  message.instructions = [
    { programIdIndex: 13, data: new Uint8Array(24).fill(9) },
    ...(message.instructions ?? []),
  ];
  const event = decodeTrade(raw);
  assert.equal(event?.side, "buy");
  assert.equal(event?.tokenAmount, 1_000n);
});
