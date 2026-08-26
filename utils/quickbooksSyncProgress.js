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
  // Google Sheets/Drive/Excel syncs ride this same channel, so the payload
  // has to say which connector it is — otherwise the UI banner labels every
  // sync "QuickBooks".
  connectorLabel = "QuickBooks",
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
    connectorLabel,
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
