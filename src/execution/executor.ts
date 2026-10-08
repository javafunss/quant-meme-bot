import bs58 from "bs58";

import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";

import type { IAlerter } from "../observability/alerter.js";
import type { Logger } from "../observability/logger.js";
import type { MetricsRegistry } from "../observability/metrics.js";
import type { IExecutor } from "../pipeline/ports.js";
import type { ExecutionResult, TradePlan } from "../types/events.js";
import { sleep } from "../utils/sleep.js";
import {
  applySlippageFloor,
  parseBondingCurve,
  solOutForTokens,
  tokensOutForSol,
} from "./bondingCurve.js";
import {
  bondingCurvePda,
  buildBuyIx,
  buildSellIx,
  createAtaIdempotentIx,
  parseFeeRecipient,
  PUMP_GLOBAL,
} from "./pumpfunIxBuilder.js";
import { raceRelays, type IRelay } from "./relay.js";
import type { IRpcClient } from "./rpcClient.js";

const LAMPORTS_PER_SOL = 1_000_000_000;

/** Jito 官方 tip 账户（公开常量），随机选一个分散路由指纹 */
const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZq5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
] as const;

export interface ExecutorOptions {
  readonly maxRetries: number;
  readonly confirmTimeoutMs: number;
  readonly computeUnitLimit: number;
  readonly computeUnitPriceMicroLamports: number;
  readonly tipMinLamports: bigint;
  readonly tipMaxLamports: bigint;
  /** 连续 N 次 execute 整体失败 → 熔断器打开，拒绝后续一切交易 */
  readonly circuitBreakerThreshold: number;
}

/** 动态 tip：按信号紧急度（评分）放大，硬顶 tipMax */
export function computeTipLamports(base: bigint, max: bigint, urgency: number): bigint {
  const multiplier = Math.max(1, Math.min(10, Math.round(urgency)));
  const tip = base * BigInt(multiplier);
  return tip > max ? max : tip;
}

/**
 * Pump.fun 执行器：曲线读取 → minOut 计算 → 构造 → simulate 预检 → 多中继竞速 → 落地确认。
 *
 * 并发与超时设计（铁律二）：
 * - 每次 execute 内部最多 maxRetries 次尝试，每次尝试取新 blockhash，for 循环有硬上界，无死循环；
 * - 所有网络调用的超时由 IRpcClient / IRelay 各自的 AbortController 保证；
 * - 确认轮询由 confirmTimeoutMs 截止时间限定；
 * - 连续 circuitBreakerThreshold 次失败 → 熔断器打开，execute 直接拒绝，等待人工 resetCircuit()。
 */
export class PumpExecutor implements IExecutor {
  private consecutiveFailures = 0;
  private circuitOpen = false;
  private feeRecipientCache: PublicKey | null = null;

  constructor(
    private readonly deps: {
      readonly rpc: IRpcClient;
      readonly relays: readonly IRelay[];
      readonly payer: Keypair;
      readonly logger: Logger;
      readonly opts: ExecutorOptions;
      readonly metrics?: MetricsRegistry | undefined;
      readonly alerter?: IAlerter | undefined;
    },
  ) {}

  get isCircuitOpen(): boolean {
    return this.circuitOpen;
  }

  /** 熔断器只接受显式人工复位 */
  resetCircuit(): void {
    this.circuitOpen = false;
    this.consecutiveFailures = 0;
    this.deps.logger.warn("circuit breaker manually reset");
  }

  async execute(plan: TradePlan): Promise<ExecutionResult> {
    const started = Date.now();
    if (this.circuitOpen) {
      this.deps.logger.error({ mint: plan.mint, side: plan.side }, "circuit breaker OPEN, execution refused");
      return { plan, signature: null, landed: false, latencyMs: 0 };
    }

    try {
      const result = await this.executeWithRetries(plan, started);
      this.consecutiveFailures = 0;
      this.deps.metrics?.incCounter("bot_execution_total", { side: plan.side, landed: "true" });
      this.deps.metrics?.observe("bot_execution_latency_ms", result.latencyMs, { side: plan.side });
      return result;
    } catch (err) {
      this.consecutiveFailures += 1;
      const open = this.consecutiveFailures >= this.deps.opts.circuitBreakerThreshold;
      if (open) this.circuitOpen = true;
      this.deps.metrics?.incCounter("bot_execution_total", { side: plan.side, landed: "false" });
      this.deps.logger.error(
        { err, mint: plan.mint, side: plan.side, consecutiveFailures: this.consecutiveFailures, circuitOpen: open },
        open ? "CIRCUIT BREAKER OPEN after repeated failures" : "execution attempt exhausted retries",
      );
      if (open) {
        this.deps.alerter?.alert("critical", "执行器熔断器打开，已停止一切交易", {
          mint: plan.mint,
          consecutiveFailures: this.consecutiveFailures,
        });
      }
      return { plan, signature: null, landed: false, latencyMs: Date.now() - started };
    }
  }

  private async executeWithRetries(plan: TradePlan, started: number): Promise<ExecutionResult> {
    let lastError: unknown = new Error("unreachable");
    for (let attempt = 1; attempt <= this.deps.opts.maxRetries; attempt++) {
      try {
        return await this.attemptOnce(plan, started);
      } catch (err) {
        lastError = err;
        this.deps.logger.warn({ err, attempt, mint: plan.mint }, "execution attempt failed");
      }
    }
    throw lastError;
  }

  private async attemptOnce(plan: TradePlan, started: number): Promise<ExecutionResult> {
    const { rpc, payer, opts } = this.deps;

    // Rug 防线：曲线账户被撤 = 流动性消失，立刻抛错计入熔断计数
    const curveAccount = await rpc.getAccountInfo(bondingCurvePda(new PublicKey(plan.mint)).toBase58());
    if (!curveAccount) throw new Error("bonding curve account unavailable (rug or migrated)");
    const curve = parseBondingCurve(curveAccount);
    if (!curve || curve.complete) throw new Error("bonding curve invalid or already completed");

    const feeRecipient = await this.ensureFeeRecipient();
    const mint = new PublicKey(plan.mint);
    // tip 双向钳制：低于下限没有竞价意义，高于上限是浪费
    const tip = plan.tipLamports < opts.tipMinLamports
      ? opts.tipMinLamports
      : plan.tipLamports > opts.tipMaxLamports
        ? opts.tipMaxLamports
        : plan.tipLamports;
    const tipAccount = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
    if (!tipAccount) throw new Error("no jito tip account");

    const tradeIx =
      plan.side === "buy"
        ? this.buildBuy(plan, curve, mint, payer.publicKey, feeRecipient)
        : this.buildSell(plan, curve, mint, payer.publicKey, feeRecipient);

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: opts.computeUnitLimit }));
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: opts.computeUnitPriceMicroLamports }));
    if (plan.side === "buy") tx.add(createAtaIdempotentIx(payer.publicKey, payer.publicKey, mint));
    tx.add(tradeIx);
    // tip 转账与交易同捆：bundle 落地才付费，落地即进区块前排
    tx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: new PublicKey(tipAccount), lamports: tip }));

    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = await rpc.getLatestBlockhash();
    tx.sign(payer);
    const serialized = tx.serialize();

    // simulate 预检：账户布局错误/余额不足/曲线异常在这里被拦下，不浪费 tip
    const sim = await rpc.simulateTransaction(serialized.toString("base64"));
    if (sim.err) throw new Error(`simulation failed: ${JSON.stringify(sim.err)}`);

    const signature = bs58.encode(tx.signatures[0]?.signature ?? new Uint8Array(64));
    await raceRelays(this.deps.relays, [serialized], this.deps.logger);

    const landed = await this.confirm(signature, opts.confirmTimeoutMs);
    if (!landed) throw new Error(`confirm timeout after ${opts.confirmTimeoutMs}ms`);
    return { plan, signature, landed: true, latencyMs: Date.now() - started };
  }

  /** buy：amount=按曲线算出的预期 token 数，maxSolCost=预算×(1+滑点) —— 成本上界锁死，夹子无利可图 */
  private buildBuy(
    plan: TradePlan,
    curve: ReturnType<typeof parseBondingCurve> & object,
    mint: PublicKey,
    buyer: PublicKey,
    feeRecipient: PublicKey,
  ) {
    const solLamports = BigInt(Math.round(plan.amountSol * LAMPORTS_PER_SOL));
    const expectedTokens = tokensOutForSol(curve, solLamports);
    const maxSolCost = (solLamports * BigInt(10_000 + plan.maxSlippageBps)) / 10_000n;
    return buildBuyIx(mint, buyer, feeRecipient, expectedTokens, maxSolCost);
  }

  /** sell：amount=卖出 token 数，minSolOutput=预期 SOL×(1-滑点) */
  private buildSell(
    plan: TradePlan,
    curve: ReturnType<typeof parseBondingCurve> & object,
    mint: PublicKey,
    seller: PublicKey,
    feeRecipient: PublicKey,
  ) {
    const tokens = plan.tokenAmount ?? 0n;
    if (tokens <= 0n) throw new Error("sell plan requires tokenAmount");
    const minSolOut = applySlippageFloor(solOutForTokens(curve, tokens), plan.maxSlippageBps);
    return buildSellIx(mint, seller, feeRecipient, tokens, minSolOut);
  }

  /** feeRecipient 从 global 账户链上解析并缓存——地址升级时无需改代码 */
  private async ensureFeeRecipient(): Promise<PublicKey> {
    if (this.feeRecipientCache) return this.feeRecipientCache;
    const global = await this.deps.rpc.getAccountInfo(PUMP_GLOBAL.toBase58());
    if (!global) throw new Error("pump global account unavailable");
    const feeRecipient = parseFeeRecipient(global);
    if (!feeRecipient) throw new Error("failed to parse feeRecipient from global account");
    this.feeRecipientCache = feeRecipient;
    return feeRecipient;
  }

  /** 确认轮询：截止时间硬约束，确认失败(err 非空)立即抛错进入重试 */
  private async confirm(signature: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const statuses = await this.deps.rpc.getSignatureStatuses([signature]);
      const status = statuses[0];
      if (status?.err) throw new Error(`tx failed on-chain: ${JSON.stringify(status.err)}`);
      if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
        return true;
      }
      await sleep(700);
    }
    return false;
  }
}
