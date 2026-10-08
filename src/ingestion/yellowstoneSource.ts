import ClientModule, {
  CommitmentLevel,
  type SubscribeRequest,
} from "@triton-one/yellowstone-grpc";

// 该包是 CJS，NodeNext 下 default 导出会包一层命名空间
const Client = ClientModule.default;

import type { Logger } from "../observability/logger.js";
import type { EventHandler, IDataSource } from "./ports.js";
import {
  decodeTokenCreation,
  decodeTrade,
  PUMP_PROGRAM_ID,
  type RawSubscribeTransaction,
} from "./pumpfunDecoder.js";

interface YellowstoneOptions {
  endpoint: string;
  token?: string | undefined;
}

const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 30_000;

export class YellowstoneSource implements IDataSource {
  readonly name = "yellowstone-grpc";
  private stopped = false;

  constructor(
    private readonly opts: YellowstoneOptions,
    private readonly logger: Logger,
  ) {}

  async start(onEvent: EventHandler): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      try {
        await this.runOnce(onEvent);
        attempt = 0;
      } catch (err) {
        if (this.stopped) break;
        attempt += 1;
        const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
        this.logger.warn({ err, attempt, delayMs: delay }, "geyser stream lost, reconnecting");
        await sleep(delay);
      }
    }
    this.logger.info("geyser source stopped");
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  private async runOnce(onEvent: EventHandler): Promise<void> {
    const client = new Client(this.opts.endpoint, this.opts.token, undefined);
    const stream = await client.subscribe();
    this.logger.info({ endpoint: this.opts.endpoint }, "geyser stream connected");

    // 服务端过滤：只推包含 Pump.fun program 的已确认交易，省带宽、省本地 CPU
    const request = {
      accounts: {},
      slots: {},
      transactions: {
        pumpfun: {
          vote: false,
          failed: false,
          accountInclude: [],
          accountExclude: [],
          accountRequired: [PUMP_PROGRAM_ID],
        },
      },
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      accountsDataSlice: [],
      commitment: CommitmentLevel.CONFIRMED,
    } as SubscribeRequest;

    await new Promise<void>((resolve, reject) => {
      stream.on("data", (update: unknown) => {
        const u = update as { ping?: unknown; transaction?: RawSubscribeTransaction };
        if (u.ping !== undefined) {
          stream.write({ ping: { id: 1 } } as SubscribeRequest, () => undefined);
          return;
        }
        if (u.transaction) {
          const event = decodeTokenCreation(u.transaction) ?? decodeTrade(u.transaction);
          if (event) onEvent(event);
        }
      });
      stream.on("error", (err: unknown) =>
        reject(err instanceof Error ? err : new Error(String(err))),
      );
      stream.on("end", () => resolve());
      stream.write(request, (err: Error | null | undefined) => {
        if (err) reject(err);
      });
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
