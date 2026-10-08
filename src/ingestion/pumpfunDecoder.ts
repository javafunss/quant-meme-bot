import bs58 from "bs58";

import type { PubkeyStr, TokenCreatedEvent, TradeEvent } from "../types/events.js";

export const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

const PROGRAM_INVOKE_PREFIX = `Program ${PUMP_PROGRAM_ID} invoke`;
const CREATE_IX_LOG = "Program log: Instruction: Create";

// Anchor 指令判别器 = sha256("global:<ix_name>")[0..8]
const BUY_DISCRIMINATOR = "66063d1201daebea";
const SELL_DISCRIMINATOR = "33e685a4017f83ad";

// pump.fun buy/sell 指令账户布局：0 global, 1 feeRecipient, 2 mint, 3 bondingCurve,
// 4 associatedBondingCurve, 5 associatedUser, 6 user
const IX_ACCOUNT_MINT = 2;
const IX_ACCOUNT_TRADER = 6;
const IX_MIN_ACCOUNTS = 7;

/** Yellowstone SubscribeUpdateTransaction 的最小结构视图：protobuf 生成类型较松散，这里收窄为严格结构 */
export interface RawSubscribeTransaction {
  slot?: unknown;
  transaction?: {
    signature?: Uint8Array;
    transaction?: {
      message?: {
        accountKeys?: Uint8Array[];
        instructions?: Array<{ programIdIndex?: number; data?: Uint8Array }>;
      };
    };
    meta?: {
      err?: unknown;
      logMessages?: string[] | null;
      preTokenBalances?: Array<{ mint?: string }> | null;
      postTokenBalances?: Array<{ mint?: string }> | null;
    } | null;
  } | null;
}

export function decodeTokenCreation(raw: RawSubscribeTransaction): TokenCreatedEvent | null {
  const info = raw.transaction;
  const meta = info?.meta;
  if (!info || !meta || meta.err) return null;

  const logs = meta.logMessages ?? [];
  const invoked = logs.some((l) => l.startsWith(PROGRAM_INVOKE_PREFIX));
  const isCreate = logs.some((l) => l.includes(CREATE_IX_LOG));
  if (!invoked || !isCreate) return null;

  const mint = inferNewMint(meta.preTokenBalances ?? [], meta.postTokenBalances ?? []);
  if (!mint) return null;

  const accountKeys = info.transaction?.message?.accountKeys ?? [];
  const creator = accountKeys[0] ? bs58.encode(accountKeys[0]) : null;

  return {
    kind: "token_created",
    slot: toSlot(raw.slot),
    signature: info.signature ? bs58.encode(info.signature) : "",
    mint,
    bondingCurve: null,
    creator,
    detectedAtMs: Date.now(),
  };
}

/** 解析 Pump.fun buy/sell 指令。任何字段异常一律返回 null（fail-safe，不抛出） */
export function decodeTrade(raw: RawSubscribeTransaction): TradeEvent | null {
  const info = raw.transaction;
  const meta = info?.meta;
  if (!info || !meta || meta.err) return null;

  const message = info.transaction?.message;
  const accountKeys = message?.accountKeys ?? [];
  const instructions = message?.instructions ?? [];

  for (const ix of instructions) {
    const programIndex = ix.programIdIndex;
    const data = ix.data;
    if (programIndex === undefined || !data || data.length < 24) continue;

    const programKey = accountKeys[programIndex];
    if (!programKey || bs58.encode(programKey) !== PUMP_PROGRAM_ID) continue;

    const discriminator = toHex(data.subarray(0, 8));
    const side = discriminator === BUY_DISCRIMINATOR ? "buy"
      : discriminator === SELL_DISCRIMINATOR ? "sell"
      : null;
    if (side === null) continue; // 非买卖的 pump 指令（如 create）跳过，继续检查后续指令

    if (accountKeys.length < IX_MIN_ACCOUNTS) return null;
    const mintKey = accountKeys[IX_ACCOUNT_MINT];
    const traderKey = accountKeys[IX_ACCOUNT_TRADER];
    if (!mintKey || !traderKey) return null;

    return {
      kind: "trade",
      slot: toSlot(raw.slot),
      signature: info.signature ? bs58.encode(info.signature) : "",
      mint: bs58.encode(mintKey),
      side,
      trader: bs58.encode(traderKey),
      tokenAmount: readU64LE(data, 8),
      solAmountLamports: readU64LE(data, 16),
      detectedAtMs: Date.now(),
    };
  }
  return null;
}

function inferNewMint(
  pre: Array<{ mint?: string }>,
  post: Array<{ mint?: string }>,
): PubkeyStr | null {
  const preMints = new Set(pre.map((b) => b.mint).filter((m): m is string => Boolean(m)));
  const fresh = post.find((b) => b.mint && !preMints.has(b.mint));
  return fresh?.mint ?? null;
}

function readU64LE(data: Uint8Array, offset: number): bigint {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getBigUint64(offset, true);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function toSlot(slot: unknown): bigint {
  try {
    return BigInt(String(slot ?? 0));
  } catch {
    return 0n;
  }
}
