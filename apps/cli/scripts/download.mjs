// The download package.mjs fetches Bun's release zips with (W7.17). github.com sometimes answers
// a release download with a 5xx for a while, so a 5xx or a network error is retried, with a backoff,
// before it gives up; any other status fails at once. The caller checks what it gets (package.mjs
// checks its sha256), so a retry never trusts a body more than the first try would.

/** The waits between tries, in milliseconds: four tries in all, over about 35 seconds. */
export const BACKOFF_MS = [5_000, 10_000, 20_000];
/** How long one try may take, its body included, before it counts as a network error. */
export const TRY_TIMEOUT_MS = 120_000;

/**
 * GET url and return its body. A 5xx or a network error is tried again after each wait in
 * backoff; the error once they run out, or on any other status, names the URL and the last
 * status (or network error).
 */
export async function download(url, { backoff = BACKOFF_MS, timeout = TRY_TIMEOUT_MS, log = (line) => console.error(line) } = {}) {
  for (let attempt = 0; ; attempt++) {
    let failure;
    try {
      // A stalled connection or body counts as a network error, so it is tried again, not waited on for good.
      const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      failure = `HTTP ${res.status}`;
      if (res.status < 500) backoff = [];
    } catch (err) {
      // fetch's own errors say only "fetch failed"; the cause says why.
      failure = `network error: ${err instanceof Error ? (err.cause?.message ?? err.message) : String(err)}`;
    }
    const tries = attempt + 1;
    if (attempt >= backoff.length) throw new Error(`downloading ${url}: ${failure}${tries > 1 ? `, after ${tries} tries` : ''}`);
    log(`downloading ${url}: ${failure}; trying again in ${backoff[attempt] / 1000} s (try ${tries} of ${backoff.length + 1})`);
    await new Promise((done) => setTimeout(done, backoff[attempt]));
  }
}
