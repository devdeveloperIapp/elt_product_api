const clampPercentage = (value) => {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return Math.round(value);
};

const buildQuickBooksSyncProgress = ({
  companyId,
  sourceId,
  stage,
  syncStatus,
  currentEntity = null,
  currentIndex = 0,
  totalEntities = 0,
  recordsProcessed = 0,
  errorMessage = null,
  lastSyncAt = null,
}) => {
  const percentage =
    totalEntities > 0
      ? clampPercentage((currentIndex / totalEntities) * 100)
      : syncStatus === "completed"
      ? 100
      : 0;

  return {
    companyId,
    sourceId,
    stage,
    syncStatus,
    currentEntity,
    currentIndex,
    totalEntities,
    recordsProcessed,
    percentage,
    errorMessage,
    lastSyncAt,
    timestamp: new Date().toISOString(),
  };
};

const emitQuickBooksSyncProgress = (payload) => {
  if (!global.io || !payload?.companyId) {
    return payload;
  }

  global.io
    .to(`company_${payload.companyId}`)
    .emit("quickbooks_sync_progress", payload);

  return payload;
};

module.exports = {
  buildQuickBooksSyncProgress,
  emitQuickBooksSyncProgress,
  clampPercentage,
};
