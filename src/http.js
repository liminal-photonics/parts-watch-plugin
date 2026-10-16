// Shared fetch wrapper: timeout plus clear errors for rate limits. Never puts URLs (which may carry keys) in errors.
const TIMEOUT_MS = Number(process.env.PARTS_WATCH_TIMEOUT_MS) || 20000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// element14 (Newark) answers a per-second or daily quota overrun with HTTP 403, not 429, and marks it in
// x-mashery-error-code (ERR_403_DEVELOPER_OVER_QPS / _OVER_RATE). That is a rate limit, not a bad key.
export function quotaKind(res) {
  const code = String(res.headers?.get?.("x-mashery-error-code") || "") + " " + String(res.headers?.get?.("x-error-detail-header") || "");
  if (/OVER_QPS|Queries Per Second/i.test(code)) return "qps";
  if (/OVER_RATE|OVER_QUOTA|Over Rate|Over Quota/i.test(code)) return "quota";
  return null;
}

export async function request(name, url, init = {}, attempt = 0) {
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    if (e.name === "TimeoutError" || e.name === "AbortError") throw new Error(`${name} timed out after ${TIMEOUT_MS / 1000} s`);
    throw new Error(`${name} network error: ${e.message}`);
  }
  const quota = res.status === 403 ? quotaKind(res) : null;
  // A per-second limit clears within a second or two; wait and retry a few times before giving up.
  if (quota === "qps" && attempt < 3) { await sleep(1100 * (attempt + 1)); return request(name, url, init, attempt + 1); }
  if (quota) throw new Error(`${name} rate limit reached (${quota === "qps" ? "too many requests per second" : "daily or hourly call quota used up"}). This is not a key problem. Wait and try again, or query fewer parts at once.`);
  if (res.status === 429) {
    const after = res.headers?.get?.("retry-after");
    throw new Error(`${name} rate limit reached${after ? `; retry after ${after} s` : ""}. Wait and try again, or query fewer parts at once.`);
  }
  return res;
}
