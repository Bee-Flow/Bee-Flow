/**
 * Shared harness for the compliance smoke scenarios.
 *
 * Owns the in-memory store fakes, the loaded check modules and the tiny test
 * runner. Required first by smoke.js, so every check module below is loaded
 * with the stubs already in place.
 */

// ── Import the real low-level modules, then overwrite their functions ──
// All checks import these same singletons, so overwrites persist.
process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'test-master-key-smoke-harness';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-smoke';

const configStore = require('../../../stores/configStore');
const complianceStore = require('../../../stores/complianceStore');
const dsrStore = require('../../../stores/dsrStore');
const dpiaStore = require('../../../stores/dpiaStore');
const incidentStore = require('../../../stores/incidentStore');
const db = require('../../../db');
const log = require('../../../telemetry/log');

// In-memory fakes for the stores
const _state = {
    config: /** @type {Record<string, any>} */ ({}),
    settings: { breach_recipients: [], dpo_email: null, dpo_name: null, privacy_notice_url: null },
    dbRows: /** @type {{query: RegExp, rows: any[]}[]} */ ([]),
    dbOne: /** @type {{query: RegExp, row: any}[]} */ ([]),
    dsrStats: /** @type {Record<string, any>} */ ({}),   // keyed by request type
    dpia: /** @type {any} */ (null),                     // latest DPIA row per agent
    incidentDeadlines: { open: 0, overdue_unnotified: 0, nearing_deadline: 0 },
};

configStore.getConfig = async (key) => _state.config[key] ?? null;
configStore.setConfig = async (key, val) => { _state.config[key] = val; };
configStore.getSecret = async () => null;

complianceStore.getSettings = async () => ({ ..._state.settings });

dsrStore.getSlaStats = async (_orgId, type) =>
    _state.dsrStats[type] ?? { total: 0, open: 0, overdue: 0, fulfilled: 0, avg_days_to_fulfil: 0 };

dpiaStore.getLatestForAgent = async () => _state.dpia;
// dpiaStore.isCurrent stays real — it is a pure function of the row.

incidentStore.getDeadlineStats = async () => ({ ..._state.incidentDeadlines });

db.getAll = async (sql) => {
    for (const m of _state.dbRows) if (m.query.test(sql)) return m.rows;
    return [];
};
db.getOne = async (sql) => {
    for (const m of _state.dbOne) if (m.query.test(sql)) return m.row;
    return null;
};

// ── Load checks after stubs are in place ──
const checks = {
    encryptionAtRest: require('../../checks/gdpr/art32-encryption-at-rest'),
    encryptionInTransit: require('../../checks/gdpr/art32-encryption-in-transit'),
    dlp: require('../../checks/gdpr/art32-dlp-enabled'),
    accessLogging: require('../../checks/gdpr/art32-access-logging'),
    breachDetection: require('../../checks/gdpr/art33-breach-detection'),
    dpo: require('../../checks/gdpr/art37-dpo-appointed'),
    privacyNotice: require('../../checks/gdpr/art12-privacy-notice'),
    externalTransfers: require('../../checks/gdpr/art44-external-transfers'),
    aiDisclosure: require('../../checks/aia/art50-ai-disclosure'),
    transparency: require('../../checks/aia/art13-transparency'),
    storageLimitation: require('../../checks/gdpr/art5-1-e-storage-limitation'),
    dsrAccess: require('../../checks/gdpr/art15-dsr-access'),
    dsrDeletion: require('../../checks/gdpr/art17-dsr-deletion'),
    ropaReviewed: require('../../checks/gdpr/art30-ropa-reviewed'),
    dpiaHighRisk: require('../../checks/gdpr/art35-dpia-high-risk'),
    subprocessors: require('../../checks/gdpr/art28-subprocessors'),
    dlpEfficacy: require('../../checks/gdpr/art32-dlp-efficacy'),
    aiLiteracy: require('../../checks/aia/art4-ai-literacy'),
    humanOversight: require('../../checks/aia/art26-human-oversight'),
    logRetention: require('../../checks/aia/art26-6-log-retention'),
    modelInventory: require('../../checks/aia/art53-model-inventory'),
    isoAccessControl: require('../../checks/iso27001/a5-15-access-control'),
    isoSecureAuth: require('../../checks/iso27001/a8-5-secure-auth'),
    isoCryptography: require('../../checks/iso27001/a8-24-cryptography'),
    isoLogging: require('../../checks/iso27001/a8-15-logging'),
    isoDeletion: require('../../checks/iso27001/a8-10-deletion'),
    isoDlp: require('../../checks/iso27001/a8-12-dlp'),
    isoMailSecurity: require('../../checks/iso27001/a5-14-mail-security'),
    isoTlsEndpoints: require('../../checks/iso27001/a8-24-tls-endpoints'),
    isoGithubVuln: require('../../checks/iso27001/a8-8-vuln-mgmt'),
    isoSourceProtection: require('../../checks/iso27001/a8-4-source-protection'),
    isoSecureCoding: require('../../checks/iso27001/a8-28-secure-coding'),
    isoChangeMgmt: require('../../checks/iso27001/a8-32-change-management'),
    isoBackups: require('../../checks/iso27001/a8-13-backups'),
    isoNetworkExposure: require('../../checks/iso27001/a8-20-network-exposure'),
    isoMonitoring: require('../../checks/iso27001/a8-16-monitoring'),
    isoIdentityHygiene: require('../../checks/iso27001/a5-16-identity-hygiene'),
    isoWorkplaceSoftware: require('../../checks/iso27001/a8-19-workplace-software'),
    isoOffboardingFeed: require('../../checks/iso27001/a6-5-offboarding-feed'),
    isoTicketedChanges: require('../../checks/iso27001/a8-32-ticketed-changes'),
};

// ── Test runner ──
// The scenarios are driven by node:test (smoke.test.js binds one TestContext
// per scenario file, so every `t(...)` below becomes a named subtest and a
// failure fails the file — this suite used to have its own runner and its own
// exit code, which is exactly why it could go red for weeks without CI
// noticing). `bindRunner(null)` restores the standalone counter, so the file
// still reports something sane if it is ever required outside node:test.
let passed = 0, failed = 0;
let ctx = null;
function bindRunner(testContext) { ctx = testContext || null; }
async function t(name, fn) {
    if (ctx) {
        // The returned promise resolves even when the subtest fails; node
        // marks the parent test as failed, so nothing is swallowed here.
        await ctx.test(name, fn);
        return;
    }
    try { await fn(); log.info('  ✅', name); passed++; }
    catch (e) { log.error('  ❌', name, '—', e.message); failed++; }
}
function assertStatus(actual, expected, msg) {
    if (actual.status !== expected) {
        throw new Error(`${msg}: expected status "${expected}", got "${actual.status}" (details: ${actual.details})`);
    }
}

function resetState() {
    _state.config = {};
    _state.settings = { breach_recipients: [], dpo_email: null, dpo_name: null, privacy_notice_url: null };
    _state.dbRows = [];
    _state.dbOne = [];
    _state.dsrStats = {};
    _state.dpia = null;
    _state.incidentDeadlines = { open: 0, overdue_unnotified: 0, nearing_deadline: 0 };
    _state.isoConnectorConfigs = {};
    _state.isoSnapshots = {};
}

// ISO connector-check stubs — configs/snapshots keyed by connector id.
const isoEvidenceStore = require('../../../stores/isoEvidenceStore');
isoEvidenceStore.getConfig = async (_orgId, connectorId) => _state.isoConnectorConfigs[connectorId] ?? null;
isoEvidenceStore.listLatestSnapshots = async (_orgId, connectorId) => _state.isoSnapshots[connectorId] ?? [];

module.exports = {
    _state,
    checks,
    t,
    bindRunner,
    assertStatus,
    resetState,
    get passed() { return passed; },
    get failed() { return failed; },
};
