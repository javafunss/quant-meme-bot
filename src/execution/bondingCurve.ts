/**
 * Pump.fun bonding curve 账户解析与定价数学（纯函数，全部 bigint，杜绝浮点误差）。
 *
 * 账户布局（Anchor）：discriminator(8) + virtualTokenReserves(u64) + virtualSolReserves(u64)
 *   + realTokenReserves(u64) + realSolReserves(u64) + tokenTotalSupply(u64) + complete(bool)
 */
export interface BondingCurveState {
  readonly virtualTokenReserves: bigint;
  readonly virtualSolReserves: bigint;
  readonly realTokenReserves: bigint;
  readonly realSolReserves: bigint;
  readonly tokenTotalSupply: bigint;
  readonly complete: boolean;
}

const CURVE_MIN_BYTES = 8 + 8 * 5 + 1;
const FEE_BPS = 100n; // pump.fun 1% 手续费
const BPS = 10_000n;

export function parseBondingCurve(data: Uint8Array): BondingCurveState | null {
  if (data.length < CURVE_MIN_BYTES) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    virtualTokenReserves: view.getBigUint64(8, true),
    virtualSolReserves: view.getBigUint64(16, true),
    realTokenReserves: view.getBigUint64(24, true),
    realSolReserves: view.getBigUint64(32, true),
    tokenTotalSupply: view.getBigUint64(40, true),
    complete: data[48] !== 0,
  };
}

/** 买入：solIn 扣 1% 手续费后按恒定乘积定价（整数除法向下取整，天然保守） */
export function tokensOutForSol(state: BondingCurveState, solInLamports: bigint): bigint {
  const effectiveSol = (solInLamports * (BPS - FEE_BPS)) / BPS;
  return (state.virtualTokenReserves * effectiveSol) / (state.virtualSolReserves + effectiveSol);
}

/** 卖出：恒定乘积定价后扣 1% 手续费 */
export function solOutForTokens(state: BondingCurveState, tokensIn: bigint): bigint {
  const gross = (state.virtualSolReserves * tokensIn) / (state.virtualTokenReserves + tokensIn);
  return (gross * (BPS - FEE_BPS)) / BPS;
}

/** 滑点保护：预期成交 × (1 - slippageBps/10000) = minOut，夹子的利润空间被数学锁死 */
export function applySlippageFloor(expectedOut: bigint, slippageBps: number): bigint {
  return (expectedOut * BigInt(10_000 - slippageBps)) / BPS;
}

/** 参考价格 lamports/token（仅用于监控显示，精度要求低，允许浮点） */
export function priceLamportsPerToken(state: BondingCurveState): number {
  if (state.virtualTokenReserves === 0n) return 0;
  return Number(state.virtualSolReserves) / Number(state.virtualTokenReserves);
}
