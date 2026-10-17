// Normalized lifecycle status. Only a status the distributor actually STATES counts as a lifecycle check.
// An empty field, a stocking status, or "no discontinued flag" is "unknown", never "active".
//   active   - source states the part is active (Digi-Key "Active", Mouser "New Product")
//   nrnd     - not recommended / not for new designs
//   eol      - end of life, last time buy, discontinued, obsolete
//   preliminary - announced but not released
//   unknown  - not stated, or only a distributor stocking status
export function classifyLifecycle(raw, { distributor } = {}) {
  const s = String(raw ?? "").trim();
  if (!s) return "unknown";
  if (/obsolete|end of life|\beol\b|last time buy|discontinued|no.?longer.?manufactured|end_of_life/i.test(s)) return "eol";
  if (/not (recommended )?for new designs?|\bnrnd\b|not recommended/i.test(s)) return "nrnd";
  if (/preliminary|pre-?release|coming soon/i.test(s)) return "preliminary";
  if (distributor === "Newark") return "unknown"; // Newark only reports its own stocking status (STOCKED, DIRECT_SHIP, ...)
  if (/^active$/i.test(s)) return "active";
  if (distributor === "Mouser" && /^new product$/i.test(s)) return "active";
  return "unknown";
}

export function lifecycleFields(raw, distributor) {
  const status = classifyLifecycle(raw, { distributor });
  return {
    lifecycleStatus: status,
    lifecycleStated: status !== "unknown",
    // A clean lifecycle check under the two-clean-check rule needs an explicit "active" statement.
    cleanLifecycleCheck: status === "active",
  };
}
