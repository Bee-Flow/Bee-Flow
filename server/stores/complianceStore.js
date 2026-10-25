// @typecheck strict
/**
 * Compliance Store — AI Act & GDPR monitoring persistence.
 *
 * Tables:
 *   compliance_settings      org-wide onboarding answers (DPO, legal bases, residency,
 *                            retention, SCC attestations, RoPA review timestamp,
 *                            retention-job heartbeat) plus, since the Compliance
 *                            Center redesign, the per-org framework set and the
 *                            regulation-specific attestation fields (NIS2, CRA/PLD,
 *                            Data Act, EAA, DORA, Machinery). Writes go through the
 *                            table-driven saveSettings — SETTINGS_FIELDS is the
 *                            whitelist.
 *   compliance_checks        time-series check results (one row per check run).
 *   compliance_evidence      append-only audit trail. Every row is a link in a
 *                            per-org hash chain (seq / prev_hash / payload_hash /
 *                            hash) — see addEvidence.
 *   compliance_score_history one snapshot per full runAll() sweep; `scores` JSONB
 *                            keyed by framework id, the legacy three columns kept.
 *   compliance_notify_log    idempotency log for the deadline notifier's tiers.
 *
 * The parts live in stores/compliance/: schema.js (the boot DDL),
 * settingsFields.js (the column table), settingsRequest.js (the request
 * boundary), settings.js, checks.js (check results + score history),
 * evidence.js (the hash chain) and findings.js (notifier log, finding states,
 * registrations, hint dismissals). This file is the store's one public entry
 * and the one place that requires the database, the DDL helper and the
 * evidence chain: it hands them to the parts, so a test that swaps '../db' for
 * a double still swaps it for every part.
 */

const { run, getOne, getAll, exec, withTransaction } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const { runDdl } = require('./lib/_ddl');
const log = require('../telemetry/log');

const { createSchema } = require('./compliance/schema');
const { SETTINGS_FIELDS, SETTINGS_REQUEST_DENY } = require('./compliance/settingsFields');
const { SettingsValidationError, sanitizeSettingsPatch } = require('./compliance/settingsRequest');
const { createSettings } = require('./compliance/settings');
const { createChecks } = require('./compliance/checks');
const { createEvidence } = require('./compliance/evidence');
const { FINDING_STATES, createFindings } = require('./compliance/findings');

const initDB = makeStoreInit('ComplianceStore', createSchema({ exec, runDdl }));

const settings = createSettings({ run, getOne, initDB });
const checks = createChecks({ run, getAll, initDB });
// Lazy, as before: the chain primitives load on the first addEvidence call.
const loadChain = () => require('../compliance/evidence/chain');
const evidence = createEvidence({ run, getOne, getAll, withTransaction, initDB, loadChain });
const findings = createFindings({ run, getOne, getAll, initDB });

log.info('[ComplianceStore] Initialized (PostgreSQL)');

module.exports = {
    initDB,
    SETTINGS_FIELDS,
    SETTINGS_REQUEST_DENY,
    SettingsValidationError,
    sanitizeSettingsPatch,
    getSettings: settings.getSettings,
    saveSettings: settings.saveSettings,
    markOnboarded: settings.markOnboarded,
    setSccConfirmed: settings.setSccConfirmed,
    markRopaReviewed: settings.markRopaReviewed,
    markRetentionRun: settings.markRetentionRun,
    recordCheckResult: checks.recordCheckResult,
    getLatestPerCheck: checks.getLatestPerCheck,
    listLatestScopes: checks.listLatestScopes,
    getLatestForChecks: checks.getLatestForChecks,
    getCheckHistory: checks.getCheckHistory,
    recordScoreSnapshot: checks.recordScoreSnapshot,
    getScoreHistory: checks.getScoreHistory,
    addEvidence: evidence.addEvidence,
    getChainHead: evidence.getChainHead,
    listEvidence: evidence.listEvidence,
    countEvidence: evidence.countEvidence,
    getEvidenceById: evidence.getEvidenceById,
    getEvidenceHistory: evidence.getEvidenceHistory,
    markNotified: findings.markNotified,
    wasNotified: findings.wasNotified,
    FINDING_STATES,
    listFindingStates: findings.listFindingStates,
    setFindingState: findings.setFindingState,
    clearFindingState: findings.clearFindingState,
    listSubjectRegistrations: findings.listSubjectRegistrations,
    upsertSubjectRegistration: findings.upsertSubjectRegistration,
    deleteSubjectRegistration: findings.deleteSubjectRegistration,
    getHintDismissals: findings.getHintDismissals,
    recordHintDismissal: findings.recordHintDismissal,
    eraseHintDismissals: findings.eraseHintDismissals,
    pruneHintDismissals: findings.pruneHintDismissals,
};
