export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SLICE_MS = 250;

/** 分片睡眠：running() 变 false 时提前返回，保证停机延迟有界 */
export async function interruptibleSleep(running: () => boolean, ms: number): Promise<void> {
  let remaining = ms;
  while (running() && remaining > 0) {
    const slice = Math.min(SLICE_MS, remaining);
    await sleep(slice);
    remaining -= slice;
  }
}
