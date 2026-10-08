import { createServer, type Server } from "node:http";

import type { Logger } from "./logger.js";

type Labels = Record<string, string>;

function metricKey(name: string, labels?: Labels): string {
  if (!labels) return name;
  const suffix = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v}"`)
    .join(",");
  return `${name}{${suffix}}`;
}

/**
 * 极简 Prometheus 指标注册表（零依赖）。
 * 只存计数/瞬时值/摘要（count+sum+max），不在内存里留原始样本——常驻进程无泄漏。
 */
export class MetricsRegistry {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly summaries = new Map<string, { count: number; sum: number; max: number }>();

  incCounter(name: string, labels?: Labels, by = 1): void {
    const key = metricKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  setGauge(name: string, value: number, labels?: Labels): void {
    this.gauges.set(metricKey(name, labels), value);
  }

  observe(name: string, value: number, labels?: Labels): void {
    const key = metricKey(name, labels);
    const s = this.summaries.get(key) ?? { count: 0, sum: 0, max: Number.NEGATIVE_INFINITY };
    s.count += 1;
    s.sum += value;
    if (value > s.max) s.max = value;
    this.summaries.set(key, s);
  }

  renderPrometheus(): string {
    const lines: string[] = [];
    for (const [key, value] of this.counters) lines.push(`${key} ${value}`);
    for (const [key, value] of this.gauges) lines.push(`${key} ${value}`);
    for (const [key, s] of this.summaries) {
      lines.push(`${key}_count ${s.count}`);
      lines.push(`${key}_sum ${s.sum}`);
      lines.push(`${key}_max ${s.max === Number.NEGATIVE_INFINITY ? 0 : s.max}`);
    }
    return `${lines.join("\n")}\n`;
  }
}

/** /metrics 与 /healthz；停机时优雅关闭（等存量连接排空由调用方进程退出兜底） */
export function startMetricsServer(
  registry: MetricsRegistry,
  port: number,
  logger: Logger,
): { stop: () => Promise<void> } {
  const server: Server = createServer((req, res) => {
    if (req.url === "/metrics") {
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      res.end(registry.renderPrometheus());
    } else if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ts: Date.now() }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  // 只绑回环地址：指标含持仓/策略信息，远程抓取请走反向代理或防火墙
  server.listen(port, "127.0.0.1", () => logger.info({ port }, "metrics server listening"));
  return {
    stop: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
