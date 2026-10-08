import type { IngestEvent } from "../types/events.js";

export type EventHandler = (event: IngestEvent) => void;

/**
 * 数据源抽象。多源冗余（Phase 4）时实现 N 个 IDataSource，
 * 由上层按 signature 去重、取先到者。
 */
export interface IDataSource {
  readonly name: string;
  start(onEvent: EventHandler): Promise<void>;
  stop(): Promise<void>;
}
