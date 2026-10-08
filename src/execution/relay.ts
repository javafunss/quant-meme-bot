import bs58 from "bs58";

import type { Logger } from "../observability/logger.js";
import type { IRpcClient } from "./rpcClient.js";

/** 中继抽象：提交已序列化签名的交易，成功返回 ack（bundleId 或 signature） */
export interface IRelay {
  readonly name: string;
  sendSignedTransactions(txs: Buffer[]): Promise<string>;
}

/**
 * Jito Block Engine：bundle 原子执行，内容在落地前不暴露给普通路由层（抗夹核心）。
 * tip 直付验证者，bundle 要么整包上链要么整包丢弃。
 */
export class JitoRelay implements IRelay {
  readonly name = "jito";

  constructor(
    private readonly blockEngineUrl: string,
    private readonly timeoutMs: number,
  ) {}

  async sendSignedTransactions(txs: Buffer[]): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("jito sendBundle timeout")), this.timeoutMs);
    try {
      const res = await fetch(`${this.blockEngineUrl}/api/v1/bundles`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "sendBundle",
          params: [txs.map((t) => bs58.encode(t))],
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`jito http ${res.status}`);
      const body = (await res.json()) as { result?: string; error?: { message: string } };
      if (body.error) throw new Error(`jito error: ${body.error.message}`);
      if (!body.result) throw new Error("jito empty bundle id");
      return body.result;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 直连 RPC 兜底中继：skipPreflight + maxRetries=0（重试由 Executor 统一控制，避免重复广播泄露） */
export class RpcRelay implements IRelay {
  readonly name = "rpc-direct";

  constructor(private readonly rpc: IRpcClient) {}

  async sendSignedTransactions(txs: Buffer[]): Promise<string> {
    const first = txs[0];
    if (!first) throw new Error("no transactions to send");
    return this.rpc.sendTransaction(first.toString("base64"));
  }
}

/**
 * 多中继竞速：同一笔签名交易并发投给全部中继，任一 ack 即成功。
 * 全部拒绝才抛错。注意这里不是"取消慢的"——Bundle 已发出就无法撤回，
 * 竞速的目的是让最快的中继帮我们赢得 leader 的区块前排。
 */
export async function raceRelays(relays: readonly IRelay[], txs: Buffer[], logger: Logger): Promise<void> {
  if (relays.length === 0) throw new Error("no relays configured");
  const results = await Promise.allSettled(relays.map((r) => r.sendSignedTransactions(txs)));
  let acked = 0;
  results.forEach((r, i) => {
    const relayName = relays[i]?.name ?? `relay-${i}`;
    if (r.status === "fulfilled") {
      acked += 1;
      logger.debug({ relay: relayName, ack: r.value }, "relay acked");
    } else {
      logger.warn({ relay: relayName, err: r.reason }, "relay rejected");
    }
  });
  if (acked === 0) throw new Error("all relays rejected the transaction");
}
