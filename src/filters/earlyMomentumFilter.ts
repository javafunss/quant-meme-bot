import type { FilterContext, IFilter } from "../pipeline/ports.js";
import type { FilterVerdict } from "../types/events.js";

interface MomentumThresholds {
  readonly minBuys: number;
  readonly minBuyers: number;
  readonly minSolInflowSol: number;
}

const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * 链上早期动量因子（发现信号，与 Skills Hub 的确认信号互补）：
 * 窗口内买入笔数 / 独立买家数 / SOL 流入各占 1/3 权重打分；
 * 窗口内零买入 → 一票否决（死币）。
 */
export class EarlyMomentumFilter implements IFilter {
  readonly name = "early-momentum";
  readonly weight = 2;

  constructor(private readonly thresholds: MomentumThresholds) {}

  evaluate(ctx: FilterContext): Promise<FilterVerdict> {
    const m = ctx.momentum;
    if (!m) {
      return Promise.resolve({ pass: true, score: 40, reasons: ["no momentum data, neutral"] });
    }
    if (m.buys === 0) {
      return Promise.resolve({ pass: false, score: 0, reasons: ["zero buys in momentum window"] });
    }

    const solInflow = Number(m.solInflowLamports) / LAMPORTS_PER_SOL;
    const ratio = (value: number, min: number): number => (min <= 0 ? 1 : Math.min(1, value / min));
    const score = Math.round(
      (ratio(m.buys, this.thresholds.minBuys) +
        ratio(m.uniqueBuyers, this.thresholds.minBuyers) +
        ratio(solInflow, this.thresholds.minSolInflowSol)) *
        (100 / 3),
    );

    return Promise.resolve({
      pass: true,
      score,
      reasons: [
        `buys ${m.buys}/${this.thresholds.minBuys}, buyers ${m.uniqueBuyers}/${this.thresholds.minBuyers}, inflow ${solInflow.toFixed(3)}/${this.thresholds.minSolInflowSol} SOL`,
      ],
    });
  }
}
