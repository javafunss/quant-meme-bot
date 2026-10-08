import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pino } from "pino";

import { SkillsHubSnapshotProvider } from "../src/intelligence/skillsHubProvider.js";
import { LifecycleRegistry } from "../src/lifecycle/lifecycleRegistry.js";

const silentLogger = pino({ level: "silent" });

test("skills-hub provider：文件缺失 → null + stale，不抛错", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skills-"));
  try {
    const provider = new SkillsHubSnapshotProvider(
      { path: join(dir, "nope.json"), pollIntervalMs: 60_000, staleThresholdMs: 1000 },
      silentLogger,
    );
    await provider.refreshNow();
    assert.deepEqual(provider.current(), { snapshot: null, stale: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("skills-hub provider：合法快照加载，畸形文件保留上一份良好快照", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skills-"));
  const path = join(dir, "snapshot.json");
  try {
    const provider = new SkillsHubSnapshotProvider(
      { path, pollIntervalMs: 60_000, staleThresholdMs: 60_000 },
      silentLogger,
    );
    await writeFile(path, JSON.stringify({
      fetchedAtMs: Date.now(),
      trendingMints: [{ mint: "m".repeat(32), symbol: "T", narrativeHeat: 88, smartMoneyNetInflowSol: null, source: "crypto-market-rank" }],
      denylistedCreators: [],
      hotTopics: ["ai"],
    }));
    await provider.refreshNow();
    assert.equal(provider.current().snapshot?.trendingMints.length, 1);
    assert.equal(provider.current().stale, false);

    // 畸形文件：mtime 更新后 refresh 失败，良好快照必须保留
    await new Promise((r) => setTimeout(r, 10));
    await writeFile(path, "{ not json");
    await provider.refreshNow();
    assert.equal(provider.current().snapshot?.trendingMints.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("lifecycle registry：去重 + TTL 淘汰", () => {
  let now = 1_000_000;
  const registry = new LifecycleRegistry(
    { ttlMs: 1000, sweepIntervalMs: 60_000 },
    silentLogger,
    () => now,
  );
  try {
    const first = registry.getOrCreate("mint-1");
    const second = registry.getOrCreate("mint-1");
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(registry.size, 1);

    now += 2000; // 超龄
    assert.equal(registry.sweep(), 1);
    assert.equal(registry.size, 0);
  } finally {
    registry.stop();
  }
});
