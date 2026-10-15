// Digi-Key Product Information API v4 client (OAuth2 client credentials).
import { request } from "./http.js";
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
  if (!res.ok) throw new Error(`Digi-Key auth failed: HTTP ${res.status}`);
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

export function normalizeDigikey(p) {
  if (!p) return null;
  const variations = p.ProductVariations || [];
  // Prefer cut tape / standard package variation with most granular breaks.
  const v = variations.find((x) => /cut tape/i.test(x?.PackageType?.Name || "")) || variations[0] || {};
  const breaks = (v.StandardPricing || []).map((b) => ({ qty: b.BreakQuantity, unitPrice: b.UnitPrice }));
  const status = p.ProductStatus?.Status || null;
  return {
    distributor: "Digi-Key",
    distributorPartNumber: v.DigiKeyProductNumber || null,
    manufacturer: p.Manufacturer?.Name || null,
    manufacturerPartNumber: p.ManufacturerProductNumber || null,
    description: p.Description?.ProductDescription || p.Description?.DetailedDescription || null,
    stock: p.QuantityAvailable ?? (variations.length ? Math.max(...variations.map((x) => x.QuantityAvailableforPackageType ?? 0)) : null),
    leadTime: p.ManufacturerLeadWeeks ? `${p.ManufacturerLeadWeeks} weeks (manufacturer)` : null,
    lifecycle: status,
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
    .map(normalizeDigikey);
}

export async function digikeyDetails(partNumber) {
  const j = await dk(`/products/v4/search/${encodeURIComponent(partNumber)}/productdetails`);
  return j?.Product ? normalizeDigikey(j.Product) : null;
}
