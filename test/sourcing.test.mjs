import { test } from "node:test";
import assert from "node:assert/strict";
import { priceAt, searchParts, status } from "../src/sourcing.js";
import { normalizeMouser } from "../src/mouser.js";
import { normalizeDigikey } from "../src/digikey.js";

test("priceAt picks the highest break not above qty", () => {
  const b = [{ qty: 1, unitPrice: 0.1 }, { qty: 100, unitPrice: 0.01 }, { qty: 1000, unitPrice: 0.005 }];
  assert.equal(priceAt(b, 99).unitPrice, 0.1);
  assert.equal(priceAt(b, 100).unitPrice, 0.01);
  assert.equal(priceAt(b, 5000).extended, 25);
  assert.deepEqual(priceAt([{ qty: 10, unitPrice: 1 }], 5), { belowMinimum: true, minimumBreak: 10 });
});

test("mouser normalize parses prices and only reports origin when present", () => {
  const n = normalizeMouser({ MouserPartNumber: "x", PriceBreaks: [{ Quantity: 1, Price: "$1,234.50", Currency: "USD" }], AvailabilityInStock: "12", ProductCompliance: [{ ComplianceName: "USHTS", ComplianceValue: "8533" }] });
  assert.equal(n.priceBreaks[0].unitPrice, 1234.5);
  assert.equal(n.stock, 12);
  assert.equal(n.countryOfOrigin, null);
});

test("digikey normalize falls back to variation stock and never invents origin", () => {
  const n = normalizeDigikey({ ManufacturerProductNumber: "A", ProductVariations: [{ DigiKeyProductNumber: "A-CT-ND", PackageType: { Name: "Cut Tape (CT)" }, QuantityAvailableforPackageType: 7, StandardPricing: [{ BreakQuantity: 1, UnitPrice: 2 }] }] });
  assert.equal(n.stock, 7);
  assert.equal(n.countryOfOrigin, null);
});

test("missing keys are skipped gracefully", async () => {
  const saved = { ...process.env };
  delete process.env.MOUSER_API_KEY; delete process.env.NEWARK_API_KEY; delete process.env.DIGIKEY_CLIENT_ID; delete process.env.DIGIKEY_CLIENT_SECRET;
  const r = await searchParts({ keyword: "x" });
  assert.deepEqual(r.results, {});
  assert.equal(r.notes.length, 4);
  assert.match(r.notes.join(" "), /No distributor was queried/);
  assert.match(status().mouser, /missing/);
  Object.assign(process.env, saved);
});

import { normalizeNewark } from "../src/newark.js";
import { getPartDetails } from "../src/sourcing.js";

test("newark normalize matches a real element14 product shape and never invents origin", () => {
  // Trimmed from a live manufacturerPartNumberSearchReturn product (www.newark.com, Oct 2026).
  const n = normalizeNewark({
    sku: "98K7338", displayName: "YAGEO - RC0603FR-0710KL - RES, THICK FILM, 10K, 1%, 0.1W, 0603",
    productStatus: "DIRECT_SHIP", rohsStatusCode: "Y-EX", packSize: 1, inv: 2033697,
    datasheets: [{ type: "T", url: "http://www.farnell.com/datasheets/3795017.pdf" }],
    prices: [{ to: 24, from: 1, cost: 0.101 }, { to: 99, from: 25, cost: 0.05 }],
    vendorName: "YAGEO", brandName: "YAGEO", translatedManufacturerPartNumber: "RC0603FR-0710KL", translatedMinimumOrderQuality: 1,
    attributes: [{ attributeLabel: "usEccn", attributeValue: "EAR99" }],
    stock: { level: 2033697, leastLeadTime: 178, status: 1, regionalBreakdown: [{ level: 1406178, warehouse: "UK" }, { level: 657580, warehouse: "US" }] },
  });
  assert.equal(n.distributor, "Newark");
  assert.equal(n.manufacturerPartNumber, "RC0603FR-0710KL");
  assert.equal(n.stock, 2033697);
  assert.deepEqual(n.stockByWarehouse, [{ warehouse: "UK", stock: 1406178 }, { warehouse: "US", stock: 657580 }]);
  assert.match(n.leadTime, /^178 days/);
  assert.equal(n.priceBreaks[1].unitPrice, 0.05);
  assert.equal(n.eccn, "EAR99");
  assert.equal(n.datasheetUrl, "http://www.farnell.com/datasheets/3795017.pdf");
  assert.equal(n.countryOfOrigin, null);
  assert.equal(n.discontinued, false);
  // NO_LONGER_STOCKED is a Newark stocking status, not manufacturer end of life.
  assert.equal(normalizeNewark({ productStatus: "NO_LONGER_STOCKED" }).endOfLife, false);
  assert.equal(normalizeNewark({ productStatus: "NO_LONGER_MANUFACTURED" }).endOfLife, true);
  // Minimum order quantity above the first break moves the first break up.
  assert.equal(normalizeNewark({ translatedMinimumOrderQuality: 5000, prices: [{ from: 1, cost: 0.005 }] }).priceBreaks[0].qty, 5000);
  assert.equal(normalizeNewark(null), null);
});

test("newark is skipped cleanly when NEWARK_API_KEY is missing", async () => {
  const saved = process.env.NEWARK_API_KEY;
  delete process.env.NEWARK_API_KEY;
  const r = await getPartDetails({ partNumber: "X", distributors: ["newark"] });
  assert.deepEqual(r.results, {});
  assert.match(r.notes[0], /Newark skipped: set NEWARK_API_KEY/);
  if (saved) process.env.NEWARK_API_KEY = saved;
});

import { compareDistributors } from "../src/sourcing.js";

test("single-source flag only when two or more distributors were queried", async () => {
  const saved = { ...process.env };
  const realFetch = globalThis.fetch;
  delete process.env.DIGIKEY_CLIENT_ID; delete process.env.DIGIKEY_CLIENT_SECRET;
  process.env.MOUSER_API_KEY = "test"; process.env.NEWARK_API_KEY = "test";
  globalThis.fetch = async (url) => {
    const body = String(url).includes("mouser")
      ? { Errors: [], SearchResults: { Parts: [{ MouserPartNumber: "1-ABC", ManufacturerPartNumber: "ABC", AvailabilityInStock: "10", PriceBreaks: [{ Quantity: 1, Price: "$1.00" }] }] } }
      : { manufacturerPartNumberSearchReturn: { numberOfResults: 0, products: [] }, premierFarnellPartNumberReturn: { numberOfResults: 0, products: [] } };
    return { ok: true, status: 200, json: async () => body };
  };
  try {
    const one = await compareDistributors({ partNumber: "ABC", quantities: [1], distributors: ["mouser"] });
    assert.equal(one.rows.length, 1);
    assert.ok(!one.flags.some((f) => /single source/.test(f)), "no single-source flag when only one distributor was queried");
    const two = await compareDistributors({ partNumber: "ABC", quantities: [1] }); // Digi-Key unconfigured; Mouser + Newark queried
    assert.ok(two.flags.some((f) => /Only found at Mouser/.test(f)));
  } finally {
    globalThis.fetch = realFetch;
    for (const k of ["MOUSER_API_KEY", "NEWARK_API_KEY"]) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

import { cleanQuantities } from "../src/sourcing.js";
import { mouserDetails } from "../src/mouser.js";

test("input validation: quantities, empty part numbers, unknown distributors", async () => {
  assert.deepEqual(cleanQuantities([100, "10", 10, 1]), [1, 10, 100]);
  assert.deepEqual(cleanQuantities(undefined), [1, 10, 100, 1000]);
  for (const bad of [[0], [-5], [1.5], ["abc"], []]) assert.throws(() => cleanQuantities(bad), /whole numbers/);
  await assert.rejects(compareDistributors({ partNumber: "   " }), /partNumber is required/);
  await assert.rejects(searchParts({ keyword: "" }), /keyword is required/);
  const r = await getPartDetails({ partNumber: "X", distributors: ["arrow"] });
  assert.match(r.notes.join(" "), /Unknown distributor "arrow"/);
});

test("mouser near matches are not reported as found; 429 gives a rate-limit message", async () => {
  const saved = process.env.MOUSER_API_KEY;
  const realFetch = globalThis.fetch;
  process.env.MOUSER_API_KEY = "test";
  try {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ Errors: [], SearchResults: { Parts: [{ MouserPartNumber: "1-ABCD", ManufacturerPartNumber: "ABCD" }] } }) });
    assert.equal(await mouserDetails("ABC"), null);
    globalThis.fetch = async () => ({ ok: false, status: 429, headers: new Map([["retry-after", "60"]]) });
    await assert.rejects(mouserDetails("ABC"), /rate limit reached; retry after 60 s/);
  } finally {
    globalThis.fetch = realFetch;
    if (saved) process.env.MOUSER_API_KEY = saved; else delete process.env.MOUSER_API_KEY;
  }
});
