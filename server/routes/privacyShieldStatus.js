/**
 * Privacy Shield status — one small, authenticated summary for the UI claims.
 *
 * The chat surface is about to carry three unconditional privacy claims (the
 * "Privacy Shield on" header pill, the "personal data is replaced" composer
 * line, the "conversations never leave your organisation" footer) and the
 * Cowork card a fourth. Each is true under exactly one configuration, and a
 * green lock that stays green while the detector is unreachable is worse than
 * no lock at all. This route answers, for the signed-in caller and their
 * effective organisation, what the runtime would do with their NEXT message —
 * and nothing else.
 *
 * Every field comes from the resolution layer the message path itself runs;
 * this file adds no truth of its own.
 *
 *   enabled         the input-PII gate, verbatim from chatWithAgent.js,
 *                   cowork/coworkShield.js and piiDetection/validate.js:
 *                   `aiConfig.piiDetectionEnabled || !!shield?.enabled`
 *   source          which switch made it true — 'org' (the org shield),
 *                   'personal' (the caller's own shield; for accounts without
 *                   an org that is the implicit secure default, BFSF-289),
 *                   'platform' (the global admin toggle, no shield) or 'off'
 *   action          what happens to detected PII, canonical vocabulary:
 *                   'redact' (masked before the model sees it), 'block' (the
 *                   message is refused), 'ask' (the DLP review dialog); null
 *                   when nothing is scanned. Follows the branch direct chat
 *                   takes (directChat/inputGates.js: the DLP path once the
 *                   shield has dlpEnabled, otherwise the legacy masking set of
 *                   piiDetection/categories.js)
 *   failMode        'fail_closed' | 'fail_open' — what a degraded detector
 *                   does to the message (validate.js piiFailureMode)
 *   guardReachable  whether the PII Guard can scan RIGHT NOW: configured,
 *                   breaker closed, /health answered 200 within the memo
 *                   window. A shield that is "on" without a reachable guard
 *                   scans nothing (detectPii() → null → fail open), so every
 *                   consumer must fold this in
 *   euMode          EU model routing is active (modelResolver.isEUModeActive)
 *   coworkEnabled   the same gate for the non-agent Cowork/Automations path,
 *                   which additionally needs an org and the per-org opt-in
 *                   flag (core/entitlements/coworkShieldFlag)
 *   chatMonitoring  chat signals for the caller's org, from the one resolver
 *                   the recorder also reads (core/entitlements/
 *                   chatMonitoringFlag): { state: 'off'|'scheduled'|'on',
 *                   from: 'YYYY-MM-DD'|null, version: ISO timestamp|null,
 *                   surfaces, signals, noticeUrl: https|null }. The composer
 *                   shows its notice from this and repeats `version` in the
 *                   marker a turn must carry to be counted, so what is
 *                   announced and what is counted cannot drift. Paused chat
 *                   types are never listed. Built by the allow-list in
 *                   core/privacy/chatSignalsNotice.js
 *
 * THE ONE RULE FOR EVERY CONSUMER: claim only when `enabled && guardReachable`
 * (Cowork: `coworkEnabled && guardReachable`); `action` picks the wording, and
 * only 'redact' may be worded as "replaced". Anything else is the negative
 * state, designed first.
 *
 * What never appears here (BFSF-441): names, e-mail, org or user ids, the
 * shield's rules or allow-terms, the guard's `load_error`/`degradedReason`
 * text, or any error message. Booleans and enums, plus (in `chatMonitoring`
 * only) one https URL the organisation itself publishes under Art. 13, a date
 * and a version timestamp. A configuration that cannot be read answers
 * `enabled: false, guardReachable: false` and chat signals off, with 200,
 * never a 500: for a status pill, "no claim" is the one answer that is safe
 * to be wrong about.
 *
 * The guard probe is memoised process-wide for GUARD_PROBE_TTL_MS and shared
 * between concurrent polls, so any number of open tabs costs at most one
 * /health call per window. The request-shaping breaker (three failed scans →
 * 10 s open) is consulted first: it is fresher than any memo.
 *
 * Known divergence, deliberately: a super admin with no org binding falls
 * back to the sole org shield in direct chat (inputGates.js). That fallback
 * reads session.isAdmin, which this self-scoped summary must not — such an
 * admin reads 'off' here even where that one path applies the shield. Erring
 * towards "no claim" is the safe direction.
 *
 * Self-scoped: the org is always resolved from the session, never from input
 * (resolveEffectiveOrgId — tier/config resolution, never an authz decision).
 * Mounted at /api/privacy/shield-status (server/index.js), beside the token
 * vault; declared in auth/accessRegistry.js. Every dependency except the
 * gate is required lazily so this module loads without a database, the same
 * discipline as core/cowork/coworkShield.js.
 */

const express = require('express');
const log = require('../telemetry/log');
const router = express.Router();
const { validate } = require('../core/http/validate');
const { z } = require('zod');

// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
const { requireAuth } = require('../auth/permissions');

// No query, said rather than left out. The answer is always about the
// CALLER's own organisation, so `?orgId=B` was answered with org A's status
// under a 200 — and whoever asked read it as B's green lock.
const NO_QUERY = z.object({}).strict('The Privacy Shield status is always your own; it takes no query parameters.');

const GUARD_PROBE_TTL_MS = 15_000;

const SOURCES = Object.freeze(['org', 'personal', 'platform', 'off']);
const ACTIONS = Object.freeze(['redact', 'block', 'ask']);
const FAIL_MODES = Object.freeze(['fail_closed', 'fail_open']);

// dlpRunner.js reads `dlpMode || 'ask'`; this is that table in the canonical
// vocabulary (orgShield.js synthesizePrivacyFields uses the same mapping).
const DLP_MODE_TO_ACTION = Object.freeze({ ask: 'ask', auto_redact: 'redact', block: 'block' });

// Chat signals: the allow-list that shapes `chatMonitoring` (pure, no I/O).
const { statusPayload: sanitizeChatMonitoring, STATUS_OFF: CHAT_MONITORING_OFF } = require('../core/privacy/chatSignalsNotice');

/**
 * The answer when nothing is on — and when the configuration cannot be read.
 * Same key set as every other answer, so a consumer never branches on shape.
 */
const OFF = Object.freeze({
    enabled: false,
    source: 'off',
    action: null,
    failMode: 'fail_closed',
    guardReachable: false,
    euMode: false,
    coworkEnabled: false,
    chatMonitoring: CHAT_MONITORING_OFF,
});

// ── Guard reachability, memoised ─────────────────────────────────────
let _guardMemo = null;     // { reachable, at }
let _guardInflight = null; // concurrent polls share one probe

async function _probeGuard() {
    const { getGuardEndpoint } = require('../core/privacy/piiDetection');
    const endpoint = await getGuardEndpoint();
    // Not installed → detectPii() returns null → nothing is scanned.
    if (!endpoint?.url) return false;
    const { probeGuardHealth } = require('../services/guardInstaller');
    // probeGuardHealth is null on anything but a 200, and the guard answers
    // 503 while its model is loading or failed — so "200" is exactly "will
    // scan now". The body (with its free-text load_error) is discarded here.
    return !!(await probeGuardHealth(endpoint.url, endpoint.apiKey));
}

/**
 * Can the PII Guard scan right now? Never throws, never probes more than once
 * per GUARD_PROBE_TTL_MS. Exported for the colocated test.
 * @returns {Promise<boolean>}
 */
function isGuardReachable() {
    const { circuitIsOpen } = require('../core/privacy/piiDetection/requestShaping');
    // The breaker saw real scans fail moments ago; a 15 s old "healthy" memo
    // must not outvote it.
    if (circuitIsOpen()) return Promise.resolve(false);
    if (_guardMemo && (Date.now() - _guardMemo.at) < GUARD_PROBE_TTL_MS) {
        return Promise.resolve(_guardMemo.reachable);
    }
    if (!_guardInflight) {
        _guardInflight = _probeGuard()
            .catch(() => false)
            .then((reachable) => {
                _guardMemo = { reachable, at: Date.now() };
                _guardInflight = null;
                return reachable;
            });
    }
    return _guardInflight;
}

// ── The fold ─────────────────────────────────────────────────────────
/**
 * Fold the resolved inputs into the response. Pure — exported so the test can
 * pin every configuration → claim mapping without a server.
 *
 * @param {object} p
 * @param {object|null} p.aiConfig     getAIConfig() — the global admin toggle
 * @param {object|null} p.orgShield    resolveOrgShield(orgId), null when off
 * @param {object|null} p.userShield   resolveUserShield(userId, …), null when off
 * @param {string|null} p.orgId        the caller's effective org
 * @param {boolean} p.coworkFlagOn     isCoworkShieldEnabled(orgId)
 * @param {boolean} p.guardReachable   isGuardReachable()
 * @param {boolean} p.euMode           isEUModeActive().isEU
 * @param {object|null} [p.chatMonitoring] resolveChatMonitoring(orgId || 'default');
 *                                     independent of the shield: a notice is
 *                                     owed whether or not the shield is on
 */
function summarizeShield({ aiConfig, orgShield, userShield, orgId, coworkFlagOn, guardReachable, euMode, chatMonitoring = null }) {
    const shield = orgShield || userShield || null;
    const platformOn = !!aiConfig?.piiDetectionEnabled;
    let enabled = platformOn || !!shield?.enabled;

    let action = null;
    if (enabled) {
        if (shield?.enabled && shield?.dlpEnabled) {
            // inputGates.js: the interactive DLP gate takes over from the
            // auto-tokenise path; dlpRunner.js decides on dlpMode.
            action = DLP_MODE_TO_ACTION[shield.dlpMode] || 'ask';
        } else {
            // validate.js: the shield's action, else the global one, else
            // block. The masking set is the one categories.js maintains —
            // everything outside it refuses the message.
            const { MASKING_ACTIONS } = require('../core/privacy/piiDetection/categories');
            const raw = shield?.piiDetectionAction || aiConfig?.piiDetectionAction || 'block';
            if (raw === 'allow') {
                // validate.js skips the scan entirely on 'allow' (a per-call
                // override that an API write can also persist). Nothing is
                // protected, so nothing is claimed.
                enabled = false;
            } else {
                action = MASKING_ACTIONS.has(raw) ? 'redact' : 'block';
            }
        }
    }

    let source = 'off';
    if (enabled) source = orgShield ? 'org' : shield ? 'personal' : 'platform';

    const rawFailMode = shield?.piiFailureMode || aiConfig?.piiFailureMode || 'fail_closed';
    const failMode = FAIL_MODES.includes(rawFailMode) ? rawFailMode : 'fail_closed';

    return {
        enabled,
        source,
        action: ACTIONS.includes(action) ? action : null,
        failMode,
        guardReachable: !!guardReachable,
        euMode: !!euMode,
        // coworkShield.js: no org → no claim; then the flag; then the gate.
        coworkEnabled: !!orgId && !!coworkFlagOn && enabled,
        chatMonitoring: sanitizeChatMonitoring(chatMonitoring),
    };
}

async function buildStatus(req) {
    const userId = req.session?.user?.id || null;
    const { resolveEffectiveOrgId, isEUModeActive } = require('../core/llm/modelResolver');
    const { getAIConfig } = require('../core/aiAgent');
    const { resolveOrgShield, resolveUserShield } = require('../core/privacy/orgShield');
    const { resolveCoworkShieldFlag } = require('../core/entitlements/coworkShieldFlag');
    const { resolveChatMonitoring } = require('../core/entitlements/chatMonitoringFlag');

    // Tier/config resolution of the caller's org (memoised 45 s) — the
    // routes/cowork.js idiom. Never an authz decision.
    const orgId = await resolveEffectiveOrgId(req, { userId }).catch(() => null);
    const aiConfig = await getAIConfig();
    // The two steps of resolveShieldFor (core/privacy/orgShield.js), unrolled
    // only so the answer can say WHICH shield applied; the arguments are the
    // same, including "no implicit personal default for an org member".
    const orgShield = orgId ? await resolveOrgShield(orgId) : null;
    const userShield = orgShield ? null : await resolveUserShield(userId, { allowImplicitDefault: !orgId });

    const [coworkFlag, eu, guardReachable, chatMonitoring] = await Promise.all([
        resolveCoworkShieldFlag(orgId), // never throws; null org reads OFF
        isEUModeActive({ userOrgId: orgId, userId }).catch(() => ({ isEU: false })),
        isGuardReachable(),
        // The recorder's org key for direct chat (core/privacy/chatSignals
        // directOrgKey): the effective org, else the 'default' bucket. Never
        // throws; any error reads off, and then nothing is counted either.
        Promise.resolve(resolveChatMonitoring(orgId || 'default')).catch(() => null),
    ]);

    return summarizeShield({
        aiConfig,
        orgShield,
        userShield,
        orgId,
        coworkFlagOn: coworkFlag.enabled,
        guardReachable,
        euMode: eu.isEU,
        chatMonitoring,
    });
}

// GET / — the caller's own effective Privacy Shield status
router.get('/', requireAuth, validate({ query: NO_QUERY }), async (req, res) => {
    let status;
    try {
        status = await buildStatus(req);
    } catch (err) {
        // Degrade, never 500: the detail stays server-side and the UI gets
        // the one answer that is safe to be wrong about — no claim.
        log.warn('[PrivacyShieldStatus] status resolution failed:', err && err.message);
        status = OFF;
    }
    // A claim cached by a proxy is exactly the stale green lock this route
    // exists to prevent.
    res.set('Cache-Control', 'no-store');
    res.json(status);
});

module.exports = router;
module.exports.summarizeShield = summarizeShield;
module.exports.sanitizeChatMonitoring = sanitizeChatMonitoring;
module.exports.isGuardReachable = isGuardReachable;
module.exports.OFF = OFF;
module.exports.SOURCES = SOURCES;
module.exports.ACTIONS = ACTIONS;
module.exports.FAIL_MODES = FAIL_MODES;
module.exports.GUARD_PROBE_TTL_MS = GUARD_PROBE_TTL_MS;
// Only for tests: the probe memo is module state and would leak between cases.
module.exports._resetGuardMemo = () => { _guardMemo = null; _guardInflight = null; };
