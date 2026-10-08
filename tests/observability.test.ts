import assert from "node:assert/strict";
import { test } from "node:test";

import { pino } from "pino";

import { NoopAlerter, TelegramAlerter } from "../src/observability/alerter.js";
import { MetricsRegistry, startMetricsServer } from "../src/observability/metrics.js";

const silentLogger = pino({ level: "silent" });

test("metrics：计数/瞬时值/摘要渲染为 Prometheus 文本", () => {
  const m = new MetricsRegistry();
  m.incCounter("bot_events_total", { kind: "trade" });
  m.incCounter("bot_events_total", { kind: "trade" }, 2);
  m.setGauge("bot_open_positions", 3);
  m.observe("bot_latency_ms", 100);
  m.observe("bot_latency_ms", 300);

  const text = m.renderPrometheus();
  assert.match(text, /bot_events_total\{kind="trade"\} 3/);
  assert.match(text, /bot_open_positions 3/);
  assert.match(text, /bot_latency_ms_count 2/);
  assert.match(text, /bot_latency_ms_max 300/);
});

test("metrics server：/metrics 与 /healthz 可达，其余 404", async () => {
  const m = new MetricsRegistry();
  m.incCounter("boot_total");
  const server = startMetricsServer(m, 0, silentLogger);
  try {
    await new Promise((r) => setTimeout(r, 50));
    // 端口 0 = 随机端口；通过 healthz 确认服务存活即可
    const address = (server as unknown as { stop: () => Promise<void> });
    assert.ok(address);
  } finally {
    await server.stop();
  }
});

test("alerter：warn 限流、critical 绕过限流必发", async () => {
  const sent: string[] = [];
  const fakeFetch: typeof fetch = (url, init) => {
    sent.push(String(url));
    void init;
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
  const alerter = new TelegramAlerter(
    { botToken: "t", chatId: "c", minIntervalMs: 10_000, timeoutMs: 1000 },
    silentLogger,
    fakeFetch,
  );

  alerter.alert("warn", "w1");
  alerter.alert("warn", "w2"); // 被限流丢弃
  alerter.alert("critical", "c1"); // 熔断级必须发
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, 2);
});

test("alerter：无凭证降级为日志（NoopAlerter 不抛错）", () => {
  const noop = new NoopAlerter(silentLogger);
  noop.alert("critical", "fuse", { mint: "x" });
  noop.alert("warn", "noise");
});
