import type { FilterContext, IFilter } from "../pipeline/ports.js";
import type { FilterVerdict } from "../types/events.js";

const NEUTRAL_SCORE = 50;
const COLD_START_SCORE = 40;

/**
 * 叙事热度过滤：命中 Skills Hub 趋势榜则采用其热度分；
 * 快照缺失/陈旧或未上榜 → 中性分放行，由聚合器与其他因子权衡（不错杀冷启动新币）。
 */
export class NarrativeHeatFilter implements IFilter {
  readonly name = "narrative-heat";
  readonly weight = 2;

  evaluate(ctx: FilterContext): Promise<FilterVerdict> {
    if (!ctx.skills) {
      return Promise.resolve({
        pass: true,
        score: NEUTRAL_SCORE,
        reasons: [ctx.skillsStale ? "skills snapshot stale/absent, neutral" : "no skills snapshot, neutral"],
      });
    }
    const hit = ctx.skills.trendingMints.find((t) => t.mint === ctx.event.mint);
    if (!hit) {
      return Promise.resolve({
        pass: true,
        score: COLD_START_SCORE,
        reasons: ["not in skills-hub trending, cold-start neutral"],
      });
    }
    const score = Math.max(0, Math.min(100, hit.narrativeHeat));
    const inflow = hit.smartMoneyNetInflowSol !== null ? `, netInflow ${hit.smartMoneyNetInflowSol} SOL` : "";
    return Promise.resolve({
      pass: true,
      score,
      reasons: [`heat ${score} via ${hit.source}${inflow}`],
    });
  }
}
