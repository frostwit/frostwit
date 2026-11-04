// Window planning for eth_getLogs. Array-address queries are limited to 100 000 blocks.
export const WINDOW = 100_000, BLOCKS_PER_SEC = 10; // 9.74 measured; 10 is conservative so we cover at least the stated hours
export const HOURS_ALLOWED = [24, 72, 168];
export const hoursToBlocks = (h) => Math.ceil(h * 3600 * BLOCKS_PER_SEC);
export function planWindows(fromBlock, toBlock, size = WINDOW) {
  const w = []; for (let a = fromBlock; a <= toBlock; a += size) w.push([a, Math.min(toBlock, a + size - 1)]); return w;
}
export const windowCount = (hours) => Math.ceil(hoursToBlocks(hours) / WINDOW);
// approx lane time for a case, for the "slow: ~N min" label (350 ms per window + 8 calls overhead + ~60 calls follow)
export const estimateCalls = (hours) => windowCount(hours) + 25;
export function halve([a, b]) { const m = a + Math.floor((b - a) / 2); return [[a, m], [m + 1, b]]; }
