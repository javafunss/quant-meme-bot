import type { FilterContext, IFilter } from "../pipeline/ports.js";
import type { FilterVerdict } from "../types/events.js";

/** dev 黑名单（Skills Hub 旁路快照）：命中即一票否决 */
export class CreatorDenylistFilter implements IFilter {
  readonly name = "creator-denylist";
  readonly weight = 1;

  evaluate(ctx: FilterContext): Promise<FilterVerdict> {
    const creator = ctx.event.creator;
    if (ctx.skills && creator && ctx.skills.denylistedCreators.includes(creator)) {
      return Promise.resolve({ pass: false, score: 0, reasons: ["creator on skills-hub denylist"] });
    }
    return Promise.resolve({ pass: true, score: 100, reasons: [] });
  }
}
