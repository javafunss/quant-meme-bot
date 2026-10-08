/** 节流 JSON-RPC 客户端：每次调用独立 AbortController 超时，定时器在 finally 中必清理 */
import type { Logger } from "../observability/logger.js";

export interface IRpcClient {
  getAccountInfo(pubkey: string): Promise<Uint8Array | null>;
  getLatestBlockhash(): Promise<string>;
  simulateTransaction(txBase64: string): Promise<{ err: unknown; logs: string[] | null }>;
  getSignatureStatuses(
    signatures: string[],
  ): Promise<Array<{ confirmationStatus?: string; err?: unknown } | null>>;
  sendTransaction(txBase64: string): Promise<string>;
  /** ATA 精确余额（原始最小单位），读不到返回 null——对账失败降级而非阻断 */
  getTokenAccountBalance(ata: string): Promise<bigint | null>;
}

interface JsonRpcEnvelope {
  result?: unknown;
  error?: { code: number; message: string };
}

export class SolanaRpcClient implements IRpcClient {
  private requestId = 0;

  constructor(
    private readonly url: string,
    private readonly timeoutMs: number,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    // 并发安全：requestId 自增即可，Node 单线程无竞态
    const id = ++this.requestId;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`rpc ${method} timeout after ${this.timeoutMs}ms`)),
      this.timeoutMs,
    );
    try {
      const res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`rpc ${method} http ${res.status}`);
      const envelope = (await res.json()) as JsonRpcEnvelope;
      if (envelope.error) throw new Error(`rpc ${method} error ${envelope.error.code}: ${envelope.error.message}`);
      return envelope.result as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async getAccountInfo(pubkey: string): Promise<Uint8Array | null> {
    const result = await this.call<{ value: { data: [string, string] } | null }>(
      "getAccountInfo",
      [pubkey, { encoding: "base64" }],
    );
    if (!result.value) return null;
    return new Uint8Array(Buffer.from(result.value.data[0], "base64"));
  }

  async getLatestBlockhash(): Promise<string> {
    const result = await this.call<{ value: { blockhash: string } }>(
      "getLatestBlockhash",
      [{ commitment: "confirmed" }],
    );
    return result.value.blockhash;
  }

  async simulateTransaction(txBase64: string): Promise<{ err: unknown; logs: string[] | null }> {
    const result = await this.call<{ value: { err: unknown; logs: string[] | null } }>(
      "simulateTransaction",
      [txBase64, { encoding: "base64", replaceRecentBlockhash: true, sigVerify: false }],
    );
    return result.value;
  }

  async getSignatureStatuses(
    signatures: string[],
  ): Promise<Array<{ confirmationStatus?: string; err?: unknown } | null>> {
    const result = await this.call<{
      value: Array<{ confirmationStatus?: string; err?: unknown } | null>;
    }>("getSignatureStatuses", [signatures, { searchTransactionHistory: false }]);
    return result.value;
  }

  async sendTransaction(txBase64: string): Promise<string> {
    return this.call<string>("sendTransaction", [
      txBase64,
      { encoding: "base64", skipPreflight: true, maxRetries: 0 },
    ]);
  }

  async getTokenAccountBalance(ata: string): Promise<bigint | null> {
    try {
      const result = await this.call<{ value: { amount: string } }>("getTokenAccountBalance", [ata]);
      return BigInt(result.value.amount);
    } catch (err) {
      this.logger.warn({ err, ata }, "getTokenAccountBalance failed, caller should degrade gracefully");
      return null;
    }
  }
}
