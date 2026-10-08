import assert from "node:assert/strict";
import { test } from "node:test";

import { pino } from "pino";

import { classifySentiment } from "../src/intelligence/binancePublicProvider.js";
import { IntelligenceService } from "../src/intelligence/intelligenceService.js";
import type { IIntelligenceProvider } from "../src/intelligence/ports.js";
import type { MacroSnapshot, Sentiment } from "../src/intelligence/types.js";

const silentLogger = pino({ level: "silent" });

function fakeProvider(sentiment: Sentiment, fetchedAtMs: number): IIntelligenceProvider {
  const snapshot: MacroSnapshot = {
    sentiment,
    btcChangePct24h: -10,
    ethChangePct24h: -10,
    solChangePct24h: -10,
    fetchedAtMs,
    source: "fake",
  };
  return { name: "fake", fetchSnapshot: () => Promise.resolve(snapshot) };
}

function makeService(provider: IIntelligenceProvider, failClosed = true): IntelligenceService {
  return new IntelligenceService(
    provider,
    { pollIntervalMs: 60_000, staleThresholdMs: 5_000, gateEnabled: true, failClosed },
    silentLogger,
  );
}

test("classifySentiment 边界：加权暴跌判 EXTREME_FEAR", () => {
  assert.equal(classifySentiment(-10, -9, -8), "EXTREME_FEAR");
  assert.equal(classifySentiment(-5, -3, -2), "FEAR"); // 加权 -3.7
  assert.equal(classifySentiment(0, 0, 0), "NEUTRAL");
  assert.equal(classifySentiment(4, 4, 4), "GREED");
  assert.equal(classifySentiment(10, 10, 10), "EXTREME_GREED");
});

test("无快照 + fail-closed：闸门阻断买入", () => {
  const gate = makeService(fakeProvider("NEUTRAL", Date.now())).currentGate();
  assert.equal(gate.allowBuys, false);
  assert.equal(gate.mode, "BLOCK_ALL");
});

test("EXTREME_FEAR 快照：阻断买入并给出原因", async () => {
  const svc = makeService(fakeProvider("EXTREME_FEAR", Date.now()));
  (svc as unknown as { snapshot: MacroSnapshot }).snapshot =
    await fakeProvider("EXTREME_FEAR", Date.now()).fetchSnapshot();
  const gate = svc.currentGate();
  assert.equal(gate.allowBuys, false);
  assert.match(gate.reason, /extreme fear/i);
});

test("快照陈旧 + fail-closed：阻断买入", async () => {
  const stale = Date.now() - 60_000;
  const svc = makeService(fakeProvider("NEUTRAL", stale));
  (svc as unknown as { snapshot: MacroSnapshot }).snapshot =
    await fakeProvider("NEUTRAL", stale).fetchSnapshot();
  const gate = svc.currentGate();
  assert.equal(gate.allowBuys, false);
  assert.equal(gate.stale, true);
});

test("NEUTRAL 新鲜快照：放行且门槛不收紧", async () => {
  const svc = makeService(fakeProvider("NEUTRAL", Date.now()));
  (svc as unknown as { snapshot: MacroSnapshot }).snapshot =
    await fakeProvider("NEUTRAL", Date.now()).fetchSnapshot();
  const gate = svc.currentGate();
  assert.equal(gate.allowBuys, true);
  assert.equal(gate.thresholdFactor, 1);
});
