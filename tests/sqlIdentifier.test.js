const test = require("node:test");
const assert = require("node:assert/strict");

const { quoteIdent } = require("../utils/sqlIdentifier");

test("quoteIdent leaves ordinary table names unchanged apart from quoting", () => {
  assert.equal(quoteIdent("customers"), '"customers"');
  assert.equal(quoteIdent("qb_invoice_line"), '"qb_invoice_line"');
  assert.equal(quoteIdent("Invoice"), '"Invoice"');
});

test("quoteIdent preserves names connectors legitimately produce", () => {
  // Sheet tabs and CRM objects routinely carry spaces, hyphens and dots.
  assert.equal(quoteIdent("Sheet 1"), '"Sheet 1"');
  assert.equal(quoteIdent("customer-orders"), '"customer-orders"');
  assert.equal(quoteIdent("2026.Q1 Sales"), '"2026.Q1 Sales"');
});

test("quoteIdent neutralises a name that tries to break out of the identifier", () => {
  const payload = 'x" ; DROP TABLE users; --';
  const quoted = quoteIdent(payload);

  assert.equal(quoted, '"x"" ; DROP TABLE users; --"');

  // The result must be a single quoted identifier: stripping the outer quotes
  // and unescaping the doubled ones has to give back exactly the input, which
  // is only true if nothing escaped into statement position.
  assert.equal(quoted.slice(1, -1).replace(/""/g, '"'), payload);
});

test("quoteIdent doubles every embedded quote, not just the first", () => {
  assert.equal(quoteIdent('a"b"c'), '"a""b""c"');
});

test("quoteIdent rejects input that cannot be a safe identifier", () => {
  assert.throws(() => quoteIdent(""), /non-empty string/);
  assert.throws(() => quoteIdent(null), /non-empty string/);
  assert.throws(() => quoteIdent(undefined), /non-empty string/);
  assert.throws(() => quoteIdent(42), /non-empty string/);
  assert.throws(() => quoteIdent("tbl\0extra"), /null byte/);
});
