// Database retention policy, distinct from the product's resource caps.
export const RETENTION = Object.freeze({
  version: '2026-10-27.1',
  rawDays: 7,
  reportDays: 30,
  accountingDays: 90,
  abandonedUploadHours: 24,
});
