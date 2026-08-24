const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildQuickBooksSyncProgress,
  clampPercentage,
} = require("../utils/quickbooksSyncProgress");

test("clampPercentage bounds values safely", () => {
  assert.equal(clampPercentage(-5), 0);
  assert.equal(clampPercentage(42.4), 42);
  assert.equal(clampPercentage(120), 100);
});

test("buildQuickBooksSyncProgress calculates entity progress percentage", () => {
  const payload = buildQuickBooksSyncProgress({
    companyId: 7,
    sourceId: 11,
    stage: "entity_sync",
    syncStatus: "in_progress",
    currentEntity: "Invoice",
    currentIndex: 6,
    totalEntities: 24,
    recordsProcessed: 250,
  });

  assert.equal(payload.companyId, 7);
  assert.equal(payload.sourceId, 11);
  assert.equal(payload.currentEntity, "Invoice");
  assert.equal(payload.percentage, 25);
  assert.equal(payload.recordsProcessed, 250);
  assert.ok(payload.timestamp);
});

test("buildQuickBooksSyncProgress forces completed state to 100 percent", () => {
  const payload = buildQuickBooksSyncProgress({
    companyId: 3,
    sourceId: 9,
    stage: "completed",
    syncStatus: "completed",
  });

  assert.equal(payload.percentage, 100);
});
