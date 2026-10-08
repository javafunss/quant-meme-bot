import type { FilterContext, IFilter } from "../pipeline/ports.js";
import type { FilterVerdict } from "../types/events.js";

/** 事件完整性检查：缺 creator / 缺 signature 的畸形事件直接否决 */
export class EventSanityFilter implements IFilter {
  readonly name = "event-sanity";
  readonly weight = 1;

  evaluate(ctx: FilterContext): Promise<FilterVerdict> {
    const problems: string[] = [];
    if (!ctx.event.creator) problems.push("missing creator");
    if (!ctx.event.signature) problems.push("missing signature");
    if (!ctx.event.mint) problems.push("missing mint");
    return Promise.resolve({
      pass: problems.length === 0,
      score: problems.length === 0 ? 100 : 0,
      reasons: problems,
    });
  }
}
