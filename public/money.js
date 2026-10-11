// money.js — HUF display formatting (tiny, dependency-free, testable).

// Hungarian format; fewer decimals as amounts grow: 0,53 Ft / 12,3 Ft / 1234 Ft.
function formatHuf(huf) {
  const digits = huf < 10 ? 2 : huf < 100 ? 1 : 0;
  return `${huf.toLocaleString("hu-HU", { minimumFractionDigits: digits, maximumFractionDigits: digits })} Ft`;
}

// Browser: global. Bun tests: CommonJS export.
if (typeof module !== "undefined") module.exports = { formatHuf };
