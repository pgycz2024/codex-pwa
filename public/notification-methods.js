// Tolerated spelling aliases inherited from the client. The generated 0.148.0
// and 0.153.2 contracts declare only the canonical names; this table does not
// establish that a historical CLI emitted these alternative spellings.
const notificationAliases = new Map([
  ["thread/statusChanged", "thread/status/changed"],
  ["thread/nameUpdated", "thread/name/updated"],
  ["thread/goalUpdated", "thread/goal/updated"],
  ["thread/goalCleared", "thread/goal/cleared"],
  ["threadStarted", "thread/started"],
  ["threadArchived", "thread/archived"],
  ["threadDeleted", "thread/deleted"],
  ["turnStarted", "turn/started"],
  ["turnCompleted", "turn/completed"],
  ["turnDiffUpdated", "turn/diff/updated"],
  ["turnPlanUpdated", "turn/plan/updated"],
  ["threadTokenUsageUpdated", "thread/tokenUsage/updated"],
  ["serverRequestResolved", "serverRequest/resolved"],
  ["itemStarted", "item/started"],
  ["itemCompleted", "item/completed"],
]);

export function normalizeNotificationMethod(value) {
  const method = String(value || "");
  return notificationAliases.get(method) || method;
}
