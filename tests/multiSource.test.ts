import assert from "node:assert/strict";
import { test } from "node:test";

import { pino } from "pino";

import { MultiSource } from "../src/ingestion/multiSource.js";
import type { EventHandler, IDataSource } from "../src/ingestion/ports.js";
import type { IngestEvent } from "../src/types/events.js";

const silentLogger = pino({ level: "silent" });

function fakeSource(name: string, events: IngestEvent[], delayMs: number): IDataSource & { started: boolean; stopped: boolean } {
  return {
    name,
    started: false,
    stopped: false,
    start(onEvent: EventHandler): Promise<void> {
      this.started = true;
      for (const e of events) setTimeout(() => onEvent(e), delayMs);
      return new Promise(() => undefined);
    },
    stop(): Promise<void> {
      this.stopped = true;
      return Promise.resolve();
    },
  };
}

function makeEvent(signature: string): IngestEvent {
  return {
    kind: "token_created",
    slot: 1n,
    signature,
    mint: "mint",
    bondingCurve: null,
    creator: "creator",
    detectedAtMs: Date.now(),
  };
}

test("多源去重：两个源推同一事件，下游只收到一次（先到者胜）", async () => {
  const a = fakeSource("a", [makeEvent("sig-1")], 5);
  const b = fakeSource("b", [makeEvent("sig-1"), makeEvent("sig-2")], 15);
  const multi = new MultiSource([a, b], 60_000, silentLogger);

  const received: string[] = [];
  void multi.start((e) => received.push(e.signature));
  await new Promise((r) => setTimeout(r, 80));

  assert.deepEqual(received.sort(), ["sig-1", "sig-2"]);
  await multi.stop();
  assert.equal(a.stopped, true);
  assert.equal(b.stopped, true);
});

test("多源：空源列表直接拒绝", () => {
  assert.throws(() => new MultiSource([], 1000, silentLogger), /at least one/);
});
