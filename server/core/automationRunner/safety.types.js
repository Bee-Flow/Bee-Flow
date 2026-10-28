// @typecheck strict
/**
 * One outbound call, as logEgress records it. `policy` is the run's resolved safety policy,
 * `auditBase` who and what the audit row belongs to, `integMeta` the ledger metadata of a
 * call that is not a catalog tool (http_request, the code step's fetch, notifications).
 * @typedef {{
 *   toolName: string,
 *   toolArgs?: Record<string, unknown>,
 *   result?: unknown,
 *   error?: unknown,
 *   blocked?: unknown,
 *   probe?: unknown,
 *   policy: import('./safety').SafetyPolicy,
 *   auditBase: import('./safety').AuditBase,
 *   mode: string,
 *   durationMs?: number,
 *   integMeta?: Record<string, unknown> | null,
 *   servedFromCache?: boolean,
 * }} EgressEntry
 */

module.exports = {};
