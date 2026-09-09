// Table and column names in the sync pipeline come from the connector catalog
// (streamItem.stream.name and jsonSchema properties), which the owner of a
// connected source controls — a spreadsheet tab or CRM object can be named
// anything, including a name containing a double quote. Those names are
// template-interpolated into raw sequelize.query() SQL, so a crafted name can
// close the identifier quote and append statements. Escaping happens here so
// every call site quotes identifiers the same way.

function quoteIdent(name) {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("SQL identifier must be a non-empty string");
  }
  if (name.includes("\0")) {
    throw new Error("SQL identifier must not contain a null byte");
  }
  // Postgres escapes a double quote inside a quoted identifier by doubling it.
  return `"${name.replace(/"/g, '""')}"`;
}

module.exports = { quoteIdent };
