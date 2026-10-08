import type { MacroSnapshot } from "./types.js";

/**
 * 外围情报适配器接口。两个实现计划：
 * - BinancePublicProvider（本 Phase）：生产路径，直连 Binance 公共 REST，无密钥、低延迟；
 * - SkillsHubSnapshotProvider（Phase 2）：读取 agent/MCP 旁路产出的本地 JSON 快照
 *   （热搜榜、Smart Money 净流入、Meme Rush 叙事阶段），与链上过滤器深耦合。
 */
export interface IIntelligenceProvider {
  readonly name: string;
  fetchSnapshot(signal?: AbortSignal): Promise<MacroSnapshot>;
}
