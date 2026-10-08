import assert from "node:assert/strict";
import { test } from "node:test";

import { pino } from "pino";

import { CreatorDenylistFilter } from "../src/filters/creatorDenylistFilter.js";
import { EventSanityFilter } from "../src/filters/eventSanityFilter.js";
import { FilterChain } from "../src/filters/filterChain.js";
import { NarrativeHeatFilter } from "../src/filters/narrativeHeatFilter.js";
import type { GateDecision } from "../src/intelligence/types.js";
import type { FilterContext, IFilter } from "../src/pipeline/ports.js";
import type { SkillsHubSnapshot, TokenCreatedEvent } from "../src/types/events.js";

const silentLogger = pino({ level: "silent" });

const event: TokenCreatedEvent = {
  kind: "token_created",
  slot: 1n,
  signature: "sig",
  mint: "mint-x",
  bondingCurve: null,
  creator: "creator-a",
  detectedAtMs: Date.now(),
};

function gate(thresholdFactor: number): GateDecision {
  return {
    mode: thresholdFactor > 1 ? "TIGHTEN" : "NORMAL",
    allowBuys: true,
    thresholdFactor,
    sizeFactor: 1,
    reason: "test",
    snapshot: null,
    stale: false,
  };
}

function ctx(skills: SkillsHubSnapshot | null, thresholdFactor = 1): FilterContext {
  return { event, gate: gate(thresholdFactor), skills, skillsStale: skills === null, momentum: null };
}

const hotSnapshot: SkillsHubSnapshot = {
  fetchedAtMs: Date.now(),
  trendingMints: [{ mint: "mint-x", symbol: "X", narrativeHeat: 90, smartMoneyNetInflowSol: 10, source: "meme-rush" }],
  denylistedCreators: [],
  hotTopics: [],
};

test("正常 regime + 高热快照：聚合放行", async () => {
  const chain = new FilterChain(
    [new EventSanityFilter(), new CreatorDenylistFilter(), new NarrativeHeatFilter()],
    { minScore: 60 },
    silentLogger,
  );
  const v = await chain.evaluate(ctx(hotSnapshot, 1));
  assert.equal(v.pass, true);
  assert.ok(v.score >= 60);
});

test("宏观收紧 thresholdFactor=1.5：门槛抬升至 90，中等热度事件被拒", async () => {
  const warm: SkillsHubSnapshot = {
    ...hotSnapshot,
    trendingMints: [{ mint: "mint-x", symbol: "X", narrativeHeat: 70, smartMoneyNetInflowSol: null, source: "meme-rush" }],
  };
  const chain = new FilterChain(
    [new EventSanityFilter(), new CreatorDenylistFilter(), new NarrativeHeatFilter()],
    { minScore: 60 },
    silentLogger,
  );
  // 加权分 = (100×1 + 100×1 + 70×2) / 4 = 85 < 门槛 90
  const v = await chain.evaluate(ctx(warm, 1.5));
  assert.equal(v.pass, false);
  assert.equal(v.score, 85);
  assert.ok(v.reasons.some((r) => r.includes("threshold 90.0")));
});

test("dev 黑名单命中：一票否决", async () => {
  const denied: SkillsHubSnapshot = { ...hotSnapshot, denylistedCreators: ["creator-a"] };
  const chain = new FilterChain([new CreatorDenylistFilter()], { minScore: 0 }, silentLogger);
  const v = await chain.evaluate(ctx(denied));
  assert.equal(v.pass, false);
  assert.equal(v.score, 0);
});

test("快照缺失：叙事因子给中性分，不错杀", async () => {
  const chain = new FilterChain([new NarrativeHeatFilter()], { minScore: 60 }, silentLogger);
  const v = await chain.evaluate(ctx(null));
  assert.equal(v.score, 50);
});

test("过滤器抛异常：fail-closed 否决", async () => {
  const bomb: IFilter = {
    name: "bomb",
    weight: 1,
    evaluate: () => Promise.reject(new Error("boom")),
  };
  const chain = new FilterChain([bomb], { minScore: 0 }, silentLogger);
  const v = await chain.evaluate(ctx(null));
  assert.equal(v.pass, false);
});
