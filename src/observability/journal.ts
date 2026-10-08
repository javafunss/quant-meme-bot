import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { Logger } from "./logger.js";

export type JournalOutcome =
  | "APPROVED"
  | "REJECTED"
  | "BLOCKED"
  | "PAPER_OPEN"
  | "PAPER_CLOSE"
  | "LIVE_OPEN"
  | "LIVE_CLOSE"
  | "FUSE";

/** 追加到决策流水的一行（JSONL），供离线回放/复盘 */
export interface JournalEntry {
  readonly tsMs: number;
  readonly mint: string;
  readonly signature: string;
  readonly outcome: JournalOutcome;
  readonly score: number | null;
  readonly gateMode: string;
  readonly sentiment: string;
  readonly reasons: readonly string[];
  /** PAPER_CLOSE 专属字段 */
  readonly pnlSol?: number;
  readonly holdMs?: number;
  readonly entryPrice?: number;
  readonly exitPrice?: number;
}

/**
 * 决策流水（JSONL 追加写）。
 * 写入串行化防止交错；写失败只记日志，绝不允许拖垮事件热路径（铁律二）。
 */
export class DecisionJournal {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly logger: Logger,
  ) {}

  record(entry: JournalEntry): void {
    this.queue = this.queue
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        await appendFile(this.path, `${JSON.stringify(entry)}\n`, "utf8");
      })
      .catch((err: unknown) => {
        this.logger.error({ err, path: this.path }, "journal write failed");
      });
  }

  /** 停机前排空写队列 */
  async flush(): Promise<void> {
    await this.queue;
  }
}
