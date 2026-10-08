import { readFile, stat } from "node:fs/promises";

import { z } from "zod";

import type { Logger } from "../observability/logger.js";
import type { SkillsHubSnapshot } from "../types/events.js";
import { interruptibleSleep } from "../utils/sleep.js";

const snapshotSchema = z.object({
  fetchedAtMs: z.number(),
  trendingMints: z.array(
    z.object({
      mint: z.string().min(32),
      symbol: z.string().nullable(),
      narrativeHeat: z.number().min(0).max(100),
      smartMoneyNetInflowSol: z.number().nullable(),
      source: z.string(),
    }),
  ),
  denylistedCreators: z.array(z.string().min(32)),
  hotTopics: z.array(z.string()),
});

interface SkillsHubOptions {
  readonly path: string;
  readonly pollIntervalMs: number;
  readonly staleThresholdMs: number;
}

/**
 * Skills Hub 旁路快照读取器：agent/MCP 定时把热搜榜、聪明钱、dev 黑名单落成 JSON，
 * BOT 只读本地文件。文件缺失/畸形 → 保留上一份良好快照，错误状态变化时才记日志（防刷屏）。
 */
export class SkillsHubSnapshotProvider {
  private snapshot: SkillsHubSnapshot | null = null;
  private loadedMtimeMs = 0;
  private running = false;
  private lastError: string | null = null;

  constructor(
    private readonly opts: SkillsHubOptions,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
  }

  /** 同步内存读，可安全用于热路径 */
  current(): { snapshot: SkillsHubSnapshot | null; stale: boolean } {
    if (this.snapshot === null) return { snapshot: null, stale: true };
    return {
      snapshot: this.snapshot,
      stale: Date.now() - this.snapshot.fetchedAtMs > this.opts.staleThresholdMs,
    };
  }

  /** 立即刷新一次（测试与启动预热用），错误不外抛 */
  async refreshNow(): Promise<void> {
    try {
      await this.refresh();
      if (this.lastError !== null) {
        this.logger.info("skills-hub snapshot recovered");
        this.lastError = null;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== this.lastError) {
        this.logger.warn({ err, path: this.opts.path }, "skills-hub snapshot unavailable, keeping last good");
        this.lastError = msg;
      }
    }
  }

  private async loop(): Promise<void> {
    while (this.running) {
      await this.refreshNow();
      await interruptibleSleep(() => this.running, this.opts.pollIntervalMs);
    }
  }

  private async refresh(): Promise<void> {
    const st = await stat(this.opts.path);
    if (st.mtimeMs <= this.loadedMtimeMs) return;

    const raw = await readFile(this.opts.path, "utf8");
    const parsed = snapshotSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new Error("skills-hub snapshot schema invalid");

    this.snapshot = parsed.data;
    this.loadedMtimeMs = st.mtimeMs;
    this.logger.info(
      {
        trending: parsed.data.trendingMints.length,
        denylisted: parsed.data.denylistedCreators.length,
        hotTopics: parsed.data.hotTopics.length,
      },
      "skills-hub snapshot loaded",
    );
  }
}
