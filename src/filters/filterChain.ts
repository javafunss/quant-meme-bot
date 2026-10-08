import type { Logger } from "../observability/logger.js";
import type { FilterContext, IFilter } from "../pipeline/ports.js";
import type { FilterVerdict } from "../types/events.js";

/**
 * 过滤器链 + 加权打分聚合。
 * - 任一过滤器 pass=false → 一票否决；
 * - 过滤器抛异常 → fail-closed，按否决处理（铁律二）；
 * - 通过门槛 = FILTER_MIN_SCORE × gate.thresholdFactor（宏观收紧时自动抬升）。
 */
export class FilterChain {
  constructor(
    private readonly filters: readonly IFilter[],
    private readonly opts: { readonly minScore: number },
    private readonly logger: Logger,
  ) {}

  async evaluate(ctx: FilterContext): Promise<FilterVerdict> {
    const reasons: string[] = [];
    let vetoed = false;
    let weightedSum = 0;
    let totalWeight = 0;

    for (const filter of this.filters) {
      let verdict: FilterVerdict;
      try {
        verdict = await filter.evaluate(ctx);
      } catch (err) {
        this.logger.error({ err, filter: filter.name }, "filter threw, fail-closed veto");
        verdict = { pass: false, score: 0, reasons: ["internal error"] };
      }
      if (!verdict.pass) vetoed = true;
      weightedSum += verdict.score * filter.weight;
      totalWeight += filter.weight;
      reasons.push(...verdict.reasons.map((r) => `${filter.name}: ${r}`));
    }

    const score = totalWeight > 0 ? weightedSum / totalWeight : 0;
    const threshold = this.opts.minScore * ctx.gate.thresholdFactor;
    const pass = !vetoed && score >= threshold;
    reasons.push(`aggregate: score ${score.toFixed(1)} vs threshold ${threshold.toFixed(1)}`);

    return { pass, score, reasons };
  }
}
