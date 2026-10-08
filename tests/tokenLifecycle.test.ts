import assert from "node:assert/strict";
import { test } from "node:test";

import { pino } from "pino";

import { TokenLifecycle } from "../src/lifecycle/tokenLifecycle.js";

const silentLogger = pino({ level: "silent" });

test("合法迁移链：DETECTED -> FILTERING -> BLOCKED", () => {
  const lc = new TokenLifecycle("mint-a", silentLogger);
  assert.equal(lc.state, "DETECTED");
  lc.transition("FILTERING");
  lc.transition("BLOCKED", "macro gate");
  assert.equal(lc.state, "BLOCKED");
});

test("非法迁移直接抛错（DETECTED -> HOLDING）", () => {
  const lc = new TokenLifecycle("mint-b", silentLogger);
  assert.throws(() => lc.transition("HOLDING"), /illegal transition/);
});

test("终态 CLOSED 不允许任何迁移", () => {
  const lc = new TokenLifecycle("mint-c", silentLogger);
  lc.transition("FILTERING");
  lc.transition("REJECTED");
  lc.transition("CLOSED");
  assert.throws(() => lc.transition("FILTERING"), /illegal transition/);
});
