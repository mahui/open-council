/**
 * Per-provider request throttler.
 * Ensures minimum interval between requests to the same provider API.
 * Prevents 429 rate limiting from Cloud Code Assist and similar services.
 */

// Minimum milliseconds between requests to the same provider.
// Measured from Cloud Code Assist API: ~1 request per 12s per model.
const PROVIDER_INTERVALS: Record<string, number> = {
  google: 12000,   // Cloud Code Assist: ~1 req/12s (429 says "reset after 11s")
  anthropic: 500,
  openai: 500,
};

const DEFAULT_INTERVAL = 1000;

const lastRequestTime = new Map<string, number>();
const queues = new Map<string, Array<() => void>>();

/**
 * Wait until it's safe to make a request to this provider.
 * Serializes requests to the same provider with minimum intervals.
 */
export async function throttle(provider: string): Promise<void> {
  const interval = PROVIDER_INTERVALS[provider] ?? DEFAULT_INTERVAL;

  // Simple approach: check last request time, wait if needed
  const last = lastRequestTime.get(provider) ?? 0;
  const elapsed = Date.now() - last;
  const waitMs = Math.max(0, interval - elapsed);

  if (waitMs > 0) {
    await new Promise(r => setTimeout(r, waitMs));
  }

  lastRequestTime.set(provider, Date.now());
}

/**
 * Record that a request to this provider just completed.
 * Call this after each successful or failed request.
 */
export function recordRequest(provider: string): void {
  lastRequestTime.set(provider, Date.now());
}
