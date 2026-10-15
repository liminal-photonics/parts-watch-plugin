// Shared fetch wrapper: timeout plus clear errors for rate limits. Never puts URLs (which may carry keys) in errors.
const TIMEOUT_MS = Number(process.env.PARTS_WATCH_TIMEOUT_MS) || 20000;

export async function request(name, url, init = {}) {
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    if (e.name === "TimeoutError" || e.name === "AbortError") throw new Error(`${name} timed out after ${TIMEOUT_MS / 1000} s`);
    throw new Error(`${name} network error: ${e.message}`);
  }
  if (res.status === 429) {
    const after = res.headers?.get?.("retry-after");
    throw new Error(`${name} rate limit reached${after ? `; retry after ${after} s` : ""}. Wait and try again, or query fewer parts at once.`);
  }
  return res;
}
