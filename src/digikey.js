// Digi-Key Product Information API v4 client (OAuth2 client credentials).
import { request } from "./http.js";
import { lifecycleFields } from "./lifecycle.js";
const BASE = process.env.DIGIKEY_API_BASE || "https://api.digikey.com";
let tokenCache = { token: null, expires: 0 };

export function digikeyConfigured() {
  return Boolean(process.env.DIGIKEY_CLIENT_ID && process.env.DIGIKEY_CLIENT_SECRET);
}

async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.expires - 30_000) return tokenCache.token;
  const body = new URLSearchParams({
    client_id: process.env.DIGIKEY_CLIENT_ID,
    client_secret: process.env.DIGIKEY_CLIENT_SECRET,
    grant_type: "client_credentials",
  });
  const res = await request("Digi-Key", `${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(res.status === 400 || res.status === 401 || res.status === 403 ? `Digi-Key rejected the client ID/secret (HTTP ${res.status}). Check DIGIKEY_CLIENT_ID and DIGIKEY_CLIENT_SECRET.` : `Digi-Key auth failed: HTTP ${res.status}`);
  const j = await res.json();
  tokenCache = { token: j.access_token, expires: Date.now() + (j.expires_in || 600) * 1000 };
  return tokenCache.token;
}

async function dk(path, init = {}, retried = false) {
  const token = await getToken();
  const res = await request("Digi-Key", `${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "X-DIGIKEY-Client-Id": process.env.DIGIKEY_CLIENT_ID,
      "X-DIGIKEY-Locale-Site": process.env.DIGIKEY_LOCALE_SITE || "US",
      "X-DIGIKEY-Locale-Language": "en",
      "X-DIGIKEY-Locale-Currency": process.env.DIGIKEY_CURRENCY || "USD",
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init.headers || {}),
    },
  });
  if (res.status === 401 && !retried) {
    tokenCache = { token: null, expires: 0 }; // token revoked or expired early: get a new one once
    return dk(path, init, true);
  }
  if (res.status === 404) return null;
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Digi-Key HTTP ${res.status}: ${t.slice(0, 300)}`);
  }
  return res.json();
}

// v4 splits one product into packaging variations (cut tape, tape & reel, Digi-Reel, tray...), each with its own
// stock, MOQ and price breaks. Pick the variation a buyer would actually order from: in stock first, then cut tape,
// then the lowest minimum order, then any variation that has prices.
export function pickVariation(variations) {
  const v = (variations || []).filter(Boolean);
  const qty = (x) => x.QuantityAvailableforPackageType ?? 0;
  const priced = (x) => (x.StandardPricing || []).length > 0;
  const cut = (x) => /cut tape/i.test(x?.PackageType?.Name || "");
  const moq = (x) => x.MinimumOrderQuantity ?? Infinity;
  return [...v].sort((a, b) => (qty(b) > 0 && priced(b)) - (qty(a) > 0 && priced(a)) || priced(b) - priced(a) || cut(b) - cut(a) || moq(a) - moq(b) || qty(b) - qty(a))[0] || {};
}

export function normalizeDigikey(p) {
  if (!p) return null;
  const variations = p.ProductVariations || [];
  const v = pickVariation(variations);
  const breaks = (v.StandardPricing || []).map((b) => ({ qty: b.BreakQuantity, unitPrice: b.UnitPrice }));
  const status = p.ProductStatus?.Status || null;
  // Packaging variations share one pool of stock (cut tape and Digi-Reel are cut from the same reels; live data for
  // LM358DR shows TR 85000, CT 85321, DKR 85321 with a product total of 85321), so summing them overcounts.
  // Use the product total when given, else the largest variation.
  const stock = p.QuantityAvailable ?? (variations.length ? Math.max(...variations.map((x) => Number(x.QuantityAvailableforPackageType) || 0)) : null);
  return {
    distributor: "Digi-Key",
    distributorPartNumber: v.DigiKeyProductNumber || null,
    manufacturer: p.Manufacturer?.Name || null,
    manufacturerPartNumber: p.ManufacturerProductNumber || null,
    description: p.Description?.ProductDescription || p.Description?.DetailedDescription || null,
    stock,
    stockByPackaging: variations.map((x) => ({ distributorPartNumber: x.DigiKeyProductNumber || null, packaging: x.PackageType?.Name || null, stock: x.QuantityAvailableforPackageType ?? null, minimumOrderQty: x.MinimumOrderQuantity ?? null })),
    leadTime: p.ManufacturerLeadWeeks ? `${p.ManufacturerLeadWeeks} weeks (manufacturer)` : null,
    leadTimeDays: Number.parseFloat(p.ManufacturerLeadWeeks) > 0 ? Math.round(Number.parseFloat(p.ManufacturerLeadWeeks) * 7) : null, // same unit at every distributor
    lifecycle: status,
    ...lifecycleFields(p.Discontinued || p.EndOfLife ? "Discontinued" : status, "Digi-Key"),
    discontinued: Boolean(p.Discontinued),
    endOfLife: Boolean(p.EndOfLife),
    countryOfOrigin: null, // Product Information API v4 does not return country of origin.
    countryOfOriginNote: "Not provided by Digi-Key Product Information API v4",
    packaging: v.PackageType?.Name || null,
    minimumOrderQty: v.MinimumOrderQuantity ?? null,
    priceBreaks: breaks,
    currency: process.env.DIGIKEY_CURRENCY || "USD",
    datasheetUrl: p.DatasheetUrl || null,
    productUrl: p.ProductUrl || null,
    rohs: p.Classifications?.RohsStatus || null,
    htsCode: p.Classifications?.HtsusCode || null,
    eccn: p.Classifications?.ExportControlClassNumber || null,
  };
}

export async function digikeySearch(keyword, limit = 10) {
  const j = await dk(`/products/v4/search/keyword`, {
    method: "POST",
    body: JSON.stringify({ Keywords: keyword, Limit: Math.min(limit, 50), Offset: 0 }),
  });
  const products = [...(j?.ExactMatches || []), ...(j?.Products || [])];
  const seen = new Set();
  return products
    .filter((p) => {
      const k = p.ManufacturerProductNumber;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, limit)
    .map((p) => ({ ...normalizeDigikey(p), stockFresh: false, stockNote: "Digi-Key keyword-search stock can be stale; use get_part_details for a refreshed count." }));
}

const norm = (x) => String(x || "").toUpperCase().replace(/\s+/g, "");

export async function digikeyDetails(partNumber) {
  const j = await dk(`/products/v4/search/${encodeURIComponent(partNumber)}/productdetails`);
  if (j?.Product) return { ...normalizeDigikey(j.Product), stockFresh: true, manufacturerConfirmed: true, exactMatch: true };
  // productdetails returns 404 when an MPN is shared by several manufacturers (e.g. LM358DR). Fall back to a
  // keyword search and keep exact manufacturer or Digi-Key part number matches only.
  const k = await dk(`/products/v4/search/keyword`, { method: "POST", body: JSON.stringify({ Keywords: partNumber, Limit: 20, Offset: 0 }) });
  const want = norm(partNumber);
  const seen = new Set();
  const exact = [...(k?.ExactMatches || []), ...(k?.Products || [])].filter((p) => {
    const hit = norm(p.ManufacturerProductNumber) === want || (p.ProductVariations || []).some((v) => norm(v.DigiKeyProductNumber) === want);
    const id = `${p.Manufacturer?.Name}|${p.ManufacturerProductNumber}`;
    if (!hit || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  if (!exact.length) return null;
  // Keyword search results can carry stale stock (live: SN74LVC1G14DBVR with Limit 20 showed 5112 while the product
  // page and productdetails showed 47112). Refresh each match by its unique Digi-Key part number. A failed or skipped
  // refresh is never hidden: the row is marked stockFresh:false with the reason, and a rate limit stops the lookup.
  const REFRESH_MAX = 8;
  const fresh = new Map();
  for (let i = 0; i < exact.length; i++) {
    const p = exact[i];
    const dkpn = pickVariation(p.ProductVariations).DigiKeyProductNumber;
    if (i >= REFRESH_MAX) { fresh.set(p, `not refreshed (only the first ${REFRESH_MAX} matches are refreshed)`); continue; }
    if (!dkpn) { fresh.set(p, "not refreshed (no Digi-Key part number)"); continue; }
    let r;
    try { r = await dk(`/products/v4/search/${encodeURIComponent(dkpn)}/productdetails`); }
    catch (e) {
      if (/rate limit/i.test(e.message)) throw e;
      fresh.set(p, `refresh failed (${e.message.slice(0, 120)})`);
      continue;
    }
    if (r?.Product && norm(r.Product.ManufacturerProductNumber) === norm(p.ManufacturerProductNumber)) { exact[i] = r.Product; fresh.set(r.Product, true); }
    else fresh.set(p, r?.Product ? "refresh returned a different part number" : "refresh found no product");
  }
  // Rank: orderable in small quantities from stock (min order <= 100 with a price), then most stock. This avoids picking
  // a reel-only broker listing (e.g. BSS138 from a reseller with a 6000-piece minimum) over the original manufacturer.
  const smallOrder = (r) => (r.stock ?? 0) > 0 && r.priceBreaks.length > 0 && (r.minimumOrderQty ?? r.priceBreaks[0].qty ?? Infinity) <= 100;
  const rows = exact.map((p) => {
    const f = fresh.get(p);
    const row = normalizeDigikey(p);
    row.stockFresh = f === true;
    if (f !== true) row.stockNote = `Digi-Key stock is from keyword search and may be stale: ${f || "not refreshed"}.`;
    return row;
  }).sort((a, b) => smallOrder(b) - smallOrder(a) || (b.stock ?? 0) - (a.stock ?? 0));
  const best = rows[0];
  // One manufacturer listing the MPN is taken as that manufacturer. With several (e.g. TI and the UMW clone), the
  // pick is tentative until another distributor confirms the maker (see preferManufacturer in core.js).
  const makers = new Set(rows.map((r) => String(r.manufacturer || "").toLowerCase()));
  best.manufacturerConfirmed = makers.size <= 1;
  if (rows.length > 1) {
    best.otherManufacturers = rows.slice(1).map((r) => ({ manufacturer: r.manufacturer, distributorPartNumber: r.distributorPartNumber, stock: r.stock, minimumOrderQty: r.minimumOrderQty }));
    best.matchNote = `${rows.length} manufacturers list ${partNumber} on Digi-Key; showing the one you can order in small quantities from stock (others under otherManufacturers). Check the manufacturer: some are second-source or clone makers.`;
  }
  // Full rows for every manufacturer, kept out of the JSON output, so the caller can switch to the manufacturer the
  // other distributors list (see preferManufacturer in the sourcing core).
  best.exactMatch = true;
  Object.defineProperty(best, "_alternatives", { value: rows, enumerable: false });
  return best;
}
