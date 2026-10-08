import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";

import { PUMP_PROGRAM_ID } from "../ingestion/pumpfunDecoder.js";

export const PUMP_PROGRAM = new PublicKey(PUMP_PROGRAM_ID);
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const BUY_DISCRIMINATOR = Buffer.from("66063d1201daebea", "hex");
const SELL_DISCRIMINATOR = Buffer.from("33e685a4017f83ad", "hex");

// 全部 PDA 运行时推导，不硬编码任何地址
export const PUMP_GLOBAL = PublicKey.findProgramAddressSync([Buffer.from("global")], PUMP_PROGRAM)[0];
export const EVENT_AUTHORITY = PublicKey.findProgramAddressSync(
  [Buffer.from("__event_authority")],
  PUMP_PROGRAM,
)[0];

export function bondingCurvePda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mint.toBuffer()], PUMP_PROGRAM)[0];
}

export function associatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM,
  )[0];
}

/** global 账户布局：disc(8) + initialized(1) + authority(32) + feeRecipient(32) + ... */
export function parseFeeRecipient(globalAccountData: Uint8Array): PublicKey | null {
  if (globalAccountData.length < 73) return null;
  return new PublicKey(globalAccountData.subarray(41, 73));
}

function ixData(discriminator: Buffer, a: bigint, b: bigint): Buffer {
  const data = Buffer.alloc(24);
  discriminator.copy(data, 0);
  data.writeBigUInt64LE(a, 8);
  data.writeBigUInt64LE(b, 16);
  return data;
}

/**
 * 幂等创建 ATA：data 单字节 0x01 = CreateIdempotent 变体。
 * 已存在则 no-op，不存在则创建——买入路径必须带它，否则首次买入新币必失败。
 */
export function createAtaIdempotentIx(payer: PublicKey, owner: PublicKey, mint: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: associatedTokenAddress(owner, mint), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

/**
 * ⚠️ 账户布局对应 pump.fun 经典 IDL。2025 年 pump.fun 在 buy/sell 增加了 creator_vault 账户，
 * 上线前必须对照最新 IDL 校验账户列表——Executor 的 simulate 预检会拦截布局错误（fail-closed）。
 */
export function buildBuyIx(
  mint: PublicKey,
  buyer: PublicKey,
  feeRecipient: PublicKey,
  amountTokens: bigint,
  maxSolCostLamports: bigint,
): TransactionInstruction {
  const curve = bondingCurvePda(mint);
  return new TransactionInstruction({
    programId: PUMP_PROGRAM,
    keys: [
      { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
      { pubkey: feeRecipient, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: curve, isSigner: false, isWritable: true },
      { pubkey: associatedTokenAddress(curve, mint), isSigner: false, isWritable: true },
      { pubkey: associatedTokenAddress(buyer, mint), isSigner: false, isWritable: true },
      { pubkey: buyer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: ixData(BUY_DISCRIMINATOR, amountTokens, maxSolCostLamports),
  });
}

export function buildSellIx(
  mint: PublicKey,
  seller: PublicKey,
  feeRecipient: PublicKey,
  tokenAmount: bigint,
  minSolOutputLamports: bigint,
): TransactionInstruction {
  const curve = bondingCurvePda(mint);
  return new TransactionInstruction({
    programId: PUMP_PROGRAM,
    keys: [
      { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
      { pubkey: feeRecipient, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: curve, isSigner: false, isWritable: true },
      { pubkey: associatedTokenAddress(curve, mint), isSigner: false, isWritable: true },
      { pubkey: associatedTokenAddress(seller, mint), isSigner: false, isWritable: true },
      { pubkey: seller, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: ixData(SELL_DISCRIMINATOR, tokenAmount, minSolOutputLamports),
  });
}
