/**
 * Org-health emitter — the single never-throws front door for writing to
 * orgHealthStore (mirror of server/support/audit.js emit()/emitSystem()).
 *
 * Contract:
 *   - one-liner call sites in hot paths (connectorBootstrap, connectorJwt,
 *     limits, directChat, ncSync, ncBindingRoutes);
 *   - fire-and-forget: outer try/catch + .catch(() => {}) — a capture failure
 *     must NEVER break bootstrap/auth/chat. Every exported function returns a
 *     promise that never rejects (awaitable in tests, ignorable in prod).
 *   - PRIVACY: meta is sanitized before storage — secret-ish keys dropped,
 *     strings truncated, emails masked, prompt/message content rejected,
 *     Error instances routed through core/errorSanitizer. Metadata only.
 *
 * Row-explosion control: problems are rolled up by the store's dedup upsert;
 * a timeline event is appended only on state transitions (insert/reopen), for
 * lifecycle codes (ALWAYS_APPEND), or when the 6h in-memory recurrence
 * throttle fires. Liveness writes are throttled to one per org/kind per
 * 15 minutes. In-memory throttles are per replica — the DB rollup remains the
 * hard cap.
 */

const { sanitizeError } = require('../core/privacy/errorSanitizer');

// Lazy store indirection so tests can inject a stub without ever loading the
// real store (which would open a pg pool). _setStore(null) restores the real one.
let _store = null;
function _getStore() {
    if (!_store) _store = require('../stores/orgHealthStore');
    return _store;
}
function _setStore(s) { _store = s || null; }

// ── Catalog ────────────────────────────────────────────────────────────────

const SEVERITIES = ['info', 'warning', 'error', 'critical'];
const ACTOR_KINDS = ['system', 'connector', 'user', 'admin'];
const NO_ACTION = 'No action needed.';

// C(code, severity, defaultMessage, remediation, lifecycle?) → catalog entry.
// category is the dot-namespace prefix; i18nKey mirrors the reserved
// admin.orgHealth.problem.<code> namespace (remedy key derivable as
// admin.orgHealth.remedy.<code>).
function C(code, severity, defaultMessage, remediation, alwaysAppend = false) {
    return {
        category: code.split('.')[0],
        severity,
        defaultMessage,
        remediation,
        i18nKey: `admin.orgHealth.problem.${code}`,
        alwaysAppend,
    };
}

// Canonical code catalog. Operator-facing English; * = lifecycle events that
// always land on the timeline (ALWAYS_APPEND).
const CODES = {
    // ── bootstrap (connector → org provisioning) ──
    'bootstrap.org_created': C('bootstrap.org_created', 'info',
        'Organization created from Nextcloud connector bootstrap.', NO_ACTION, true),
    'bootstrap.org_adopted': C('bootstrap.org_adopted', 'info',
        'Existing organization adopted by the Nextcloud instance after email verification.', NO_ACTION, true),
    'bootstrap.returning_bind': C('bootstrap.returning_bind', 'info',
        'Known Nextcloud instance re-bound to its organization on bootstrap.', NO_ACTION),
    'bootstrap.pairing_redeemed': C('bootstrap.pairing_redeemed', 'info',
        'Pairing code redeemed — Nextcloud instance bound to the organization.', NO_ACTION, true),
    'bootstrap.verification_pending': C('bootstrap.verification_pending', 'warning',
        'Bootstrap is waiting for admin email verification.',
        'Ask the Nextcloud admin to enter the verification code sent to their email, or re-send it from the connector setup screen.'),
    'bootstrap.verification_succeeded': C('bootstrap.verification_succeeded', 'info',
        'Admin email verification succeeded.', NO_ACTION, true),
    'bootstrap.verify_failed': C('bootstrap.verify_failed', 'error',
        'Could not verify Nextcloud instance ownership (capabilities round-trip failed).',
        'Check that the Nextcloud base URL is reachable from Bee Flow and that the instance id matches, then retry the connector setup.'),
    'bootstrap.pairing_required': C('bootstrap.pairing_required', 'warning',
        'Bootstrap refused: this Nextcloud instance must be paired with an existing organization first.',
        'Generate a pairing code in the Bee Flow admin (Organization → Nextcloud) and enter it in the connector setup.'),
    'bootstrap.pairing_code_invalid': C('bootstrap.pairing_code_invalid', 'warning',
        'An invalid or expired pairing code was submitted.',
        'Generate a fresh pairing code and try again — codes are single-use and expire.'),
    'bootstrap.admin_email_conflict': C('bootstrap.admin_email_conflict', 'error',
        'The Nextcloud admin email already belongs to a user in another organization.',
        'Use a different admin email in Nextcloud, or detach/move the existing Bee Flow user before retrying.'),
    'bootstrap.too_many_pending_bindings': C('bootstrap.too_many_pending_bindings', 'warning',
        'Too many pending binding/verification attempts for this organization.',
        'Wait for pending verifications to expire or cancel them in the admin, then retry.'),
    'bootstrap.org_create_failed': C('bootstrap.org_create_failed', 'critical',
        'Creating the organization during connector bootstrap failed.',
        'Check server logs around the bootstrap timestamp and retry the connector setup; if it persists, contact support.'),
    'bootstrap.admin_provision_failed': C('bootstrap.admin_provision_failed', 'error',
        'The Nextcloud admin user could not be provisioned in the organization.',
        'Verify the admin has a valid, non-conflicting email in Nextcloud, then re-run the connector setup.'),
    'bootstrap.plan_applied': C('bootstrap.plan_applied', 'info',
        'A default subscription plan was applied to the organization.', NO_ACTION, true),
    'bootstrap.plan_apply_failed': C('bootstrap.plan_apply_failed', 'error',
        'Applying the default subscription plan failed.',
        'Assign a subscription plan to this organization manually (super-admin → Subscriptions).'),
    'bootstrap.community_fallback': C('bootstrap.community_fallback', 'critical',
        'No default plan is configured for Nextcloud signups — the organization was provisioned without a subscription, so every AI request is blocked on cloud.',
        'Configure an NC-recommended default plan (super-admin → Plans) or assign this organization a subscription; until then every AI request is blocked on cloud.'),

    // ── auth (per-request connector gate exits — rollup-only) ──
    'auth.no_matching_tenant_key': C('auth.no_matching_tenant_key', 'critical',
        'Connector requests are signed with a tenant key that does not match any known organization.',
        'The connector likely holds a stale tenant key — run /connector/diagnose from the Nextcloud app or re-pair the instance.'),
    'auth.missing_email': C('auth.missing_email', 'error',
        'A Nextcloud user without an email address tried to sign in.',
        'Set an email address for the user in Nextcloud — accounts cannot be created without one.'),
    'auth.blocked_onboarding_pending': C('auth.blocked_onboarding_pending', 'warning',
        'Users are blocked because the organization onboarding wizard has not been completed.',
        'An organization admin must open Bee Flow from Nextcloud once and complete the onboarding wizard.'),
    'auth.blocked_manual_mode': C('auth.blocked_manual_mode', 'warning',
        'User sign-in blocked: the organization is in manual user-provisioning mode.',
        'Add the user manually in Bee Flow, or switch the sync mode in the organization Nextcloud settings.'),
    'auth.blocked_pending_approval': C('auth.blocked_pending_approval', 'warning',
        'Users are waiting for admin approval and cannot use AI yet.',
        'Approve pending users in Admin → Users, or set new Nextcloud users to be active by default in the organization settings.'),
    'auth.blocked_seat_cap': C('auth.blocked_seat_cap', 'error',
        'User sign-in blocked: the organization reached its seat limit.',
        'Raise the seat limit on the subscription plan or deactivate unused users.'),
    'auth.blocked_geo': C('auth.blocked_geo', 'warning',
        'User sign-in blocked by the geo/IP policy.',
        'Review the organization geo restrictions if this user should have access.'),
    'auth.blocked_org_mismatch': C('auth.blocked_org_mismatch', 'error',
        'A user account exists under a different organization than the connector key.',
        'Detach or move the conflicting user, or re-pair the connector with the correct organization.'),
    'auth.provision_failed': C('auth.provision_failed', 'error',
        'Auto-provisioning a Nextcloud user failed.',
        'Check the user details in Nextcloud (email, uid) and the server logs; the user can retry after the issue is fixed.'),
    'auth.user_auto_provisioned': C('auth.user_auto_provisioned', 'info',
        'A Nextcloud user was auto-provisioned.', NO_ACTION, true),
    'auth.encryption_key_failed': C('auth.encryption_key_failed', 'error',
        'Deriving the user encryption key failed during connector sign-in.',
        'The user may need to re-run encryption setup; check server logs for the key-derivation error.'),
    'auth.session_save_failed': C('auth.session_save_failed', 'error',
        'Saving the user session failed during connector sign-in.',
        'Check Redis/session-store health — users cannot stay signed in until this is fixed.'),

    // ── chat (subscription gate + provider/DLP exits) ──
    'chat.subscription_blocked': C('chat.subscription_blocked', 'critical',
        'AI requests are blocked because the organization has no active subscription.',
        'Assign a subscription to this organization, or configure the NC-recommended default plan so new connector organizations get one automatically.'),
    'chat.budget_exhausted': C('chat.budget_exhausted', 'warning',
        'AI requests are being rejected because the subscription budget or message limit is exhausted.',
        'Raise the plan limits or wait for the next billing cycle.'),
    'chat.provider_config_failed': C('chat.provider_config_failed', 'error',
        'No usable AI provider configuration was found for the requested model.',
        'Check the provider API keys and model configuration for this organization.'),
    'chat.provider_error': C('chat.provider_error', 'error',
        'The AI provider returned an error during streaming.',
        'Check provider status and API-key quotas; the sanitized error details are in the problem metadata.'),
    'chat.dlp_blocked': C('chat.dlp_blocked', 'info',
        'A message was blocked by the DLP policy.',
        'Review the organization shield/DLP configuration if this is unexpected.'),

    // ── binding (admin-driven pairing lifecycle) ──
    'binding.approved': C('binding.approved', 'info',
        'A Nextcloud binding request was approved.', NO_ACTION, true),
    'binding.denied': C('binding.denied', 'info',
        'A Nextcloud binding request was denied.', NO_ACTION, true),
    'binding.removed': C('binding.removed', 'info',
        'A Nextcloud binding was removed.', NO_ACTION, true),
    'binding.pairing_code_generated': C('binding.pairing_code_generated', 'info',
        'A pairing code was generated.', NO_ACTION, true),

    // ── onboarding ──
    'onboarding.completed': C('onboarding.completed', 'info',
        'The organization completed the Nextcloud onboarding wizard.', NO_ACTION, true),

    // ── connector (phone-home) ──
    'connector.reported_error': C('connector.reported_error', 'error',
        'The Nextcloud connector reported an error via phone-home.',
        'Open the connector diagnostics in Nextcloud (Settings → Bee Flow); the reported category and code are in the problem metadata.'),
    'connector.key_divergence': C('connector.key_divergence', 'critical',
        'Connector signs with a stale tenant key — its requests cannot be authenticated.',
        'Run /connector/diagnose from the Nextcloud app or re-pair the instance to rotate the tenant key.'),
    // warning, not error: error/critical mark the org as unable to use AI chat
    // (fleet banner, OrgHealthBanner), and a failing user sync does not do that.
    'connector.nc_sync_failed': C('connector.nc_sync_failed', 'warning',
        'User and group sync with Nextcloud is failing: Bee Flow cannot read the user list through the connector, so users, groups and deactivations are stale.',
        'Check that the Bee Flow app is enabled and healthy in Nextcloud (Settings → Bee Flow, connection check) or re-pair the instance, then run "Sync now" in the organization Nextcloud sync settings. While this is open the automatic sync retries once every 24 hours.'),
};

const ALWAYS_APPEND = new Set(Object.keys(CODES).filter(c => CODES[c].alwaysAppend));

function _fallbackDef(code) {
    const category = String(code || '').split('.')[0] || 'connector';
    return {
        category,
        severity: 'warning',
        defaultMessage: String(code || 'unknown'),
        remediation: null,
        i18nKey: `admin.orgHealth.problem.${code}`,
        alwaysAppend: false,
    };
}

// ── Meta sanitizer (privacy contract) ──────────────────────────────────────

const DROP_KEY_RE = /token|secret|key|password|authorization|cookie/i;
const REJECT_CONTENT_RE = /^(content|prompt|message_body)$/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const MAX_STRING = 300;
const MAX_DEPTH = 2;

// Same masking shape as connectorBootstrap.maskEmail: first char + ••• +
// last char + full domain ('tomsmit@beeflow.nl' → 't•••t@beeflow.nl').
function _maskEmail(email) {
    const [local = '', domain = ''] = String(email || '').split('@');
    if (!domain) return '***';
    const first = local.slice(0, 1) || '*';
    const last = local.length > 1 ? local.slice(-1) : '';
    return `${first}${'•'.repeat(3)}${last}@${domain}`;
}

function _sanitizeString(s) {
    let out = String(s).replace(EMAIL_RE, m => _maskEmail(m));
    if (out.length > MAX_STRING) out = out.slice(0, MAX_STRING) + '…';
    return out;
}

function _sanitizeValue(v, depth) {
    if (v === null) return null;
    const t = typeof v;
    if (t === 'string') return _sanitizeString(v);
    if (t === 'number') return Number.isFinite(v) ? v : null;
    if (t === 'boolean') return v;
    if (v instanceof Date) return v.toISOString();
    if (v instanceof Error) {
        // Provider/runtime errors must pass through the error sanitizer —
        // never store raw messages/stacks (they can echo payloads).
        const s = sanitizeError(v);
        return { errorCode: s.error_code, errorClass: s.error_class, errorFirstLine: s.error_first_line };
    }
    if (Array.isArray(v)) {
        if (depth >= MAX_DEPTH) return undefined;
        return v.slice(0, 20).map(x => _sanitizeValue(x, depth + 1)).filter(x => x !== undefined);
    }
    if (t === 'object') {
        if (depth >= MAX_DEPTH) return undefined;
        return _sanitizeObject(v, depth + 1);
    }
    return undefined; // functions, symbols, bigints — dropped
}

function _sanitizeObject(obj, depth) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        if (REJECT_CONTENT_RE.test(k)) continue;   // NEVER prompt/message content
        if (DROP_KEY_RE.test(k)) continue;         // secret-ish keys dropped wholesale
        const sv = _sanitizeValue(v, depth);
        if (sv !== undefined) out[k] = sv;
    }
    return out;
}

/**
 * Sanitize a meta object for storage. Drops secret-ish keys
 * (/token|secret|key|password|authorization|cookie/i), rejects content-bearing
 * fields (content/prompt/message_body), truncates strings to 300 chars, masks
 * emails, converts Error instances via core/errorSanitizer, caps nesting at
 * depth 2. Always returns a plain object; never throws.
 */
function _sanitizeMeta(input) {
    try {
        if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
        return _sanitizeObject(input, 1);
    } catch (_) {
        return {};
    }
}

// ── Subject-key resolution ─────────────────────────────────────────────────

function _resolveSubjectKey({ orgId, ncInstanceId, subjectKey } = {}) {
    if (orgId) return String(orgId);
    if (ncInstanceId) return `nc:${String(ncInstanceId).slice(0, 120)}`;
    if (subjectKey) return String(subjectKey).slice(0, 160);
    return 'unknown';
}

function _clientIp(req) {
    if (!req) return null;
    const xf = req.headers && req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
    return req.ip || (req.socket && req.socket.remoteAddress) || null;
}

// ── In-memory throttles (per replica; DB rollup is the hard cap) ───────────

const RECURRENCE_WINDOW_MS = 6 * 60 * 60 * 1000;  // 6h between recurrence events
const LIVENESS_WINDOW_MS = 15 * 60 * 1000;        // 15 min between liveness writes
const LIVENESS_KINDS = new Set(['authOk', 'bootstrap', 'statusReport']);

let _now = () => Date.now();
const _recurrenceMarks = new Map();
const _livenessMarks = new Map();

function _capMap(map, max = 10000) {
    if (map.size > max) map.clear(); // crude but bounded; per-replica hygiene
}

/** Test hook: inject a fake clock (pass nothing to restore Date.now). */
function _setNow(fn) { _now = typeof fn === 'function' ? fn : () => Date.now(); }
/** Test hook: clear all in-memory throttle state. */
function _resetThrottles() { _recurrenceMarks.clear(); _livenessMarks.clear(); }

// ── Emit API (fire-and-forget; returned promises never reject) ─────────────

async function _problemAsync(code, opts) {
    const def = CODES[code] || _fallbackDef(code);
    const subjectKey = _resolveSubjectKey(opts);
    const organizationId = opts.orgId != null ? String(opts.orgId) : null;
    const severity = SEVERITIES.includes(opts.severity) ? opts.severity : def.severity;
    const message = (typeof opts.message === 'string' && opts.message)
        ? _sanitizeString(opts.message)
        : def.defaultMessage;
    const meta = _sanitizeMeta(opts.meta);
    const store = _getStore();

    let result = null;
    try {
        result = await store.upsertProblem({
            subjectKey, organizationId, code,
            category: def.category, severity,
            source: opts.source || 'unknown',
            message, remediation: def.remediation, meta,
        });
    } catch (_) {
        return; // capture failure must never break the caller
    }

    // Timeline append policy: state transitions always; lifecycle codes always;
    // otherwise at most once per 6h per (subject, code).
    const transition = !!(result && (result.inserted || result.reopened));
    const throttleKey = `${subjectKey}|${code}`;
    const now = _now();
    const last = _recurrenceMarks.get(throttleKey);
    const throttleOpen = last == null || (now - last) >= RECURRENCE_WINDOW_MS;
    if (!transition && !ALWAYS_APPEND.has(code) && !throttleOpen) return;
    _recurrenceMarks.set(throttleKey, now);
    _capMap(_recurrenceMarks);
    try {
        await store.appendEvent({
            subjectKey, organizationId, code,
            category: def.category, severity,
            actorKind: 'system', actorUserId: null,
            message,
            meta: (result && result.count > 1) ? { ...meta, occurrenceCount: result.count } : meta,
            ip: _clientIp(opts.req),
        });
    } catch (_) { /* swallow */ }
}

/**
 * Record (or bump) a problem for a subject. One-liner-safe:
 *   orgHealth.problem('bootstrap.community_fallback', { orgId });
 * Options: { orgId, ncInstanceId, subjectKey, meta, message, severity, source, req }
 */
function problem(code, opts = {}) {
    try {
        return _problemAsync(code, opts || {}).catch(() => { });
    } catch (_) {
        return Promise.resolve();
    }
}

async function _eventAsync(code, opts) {
    const def = CODES[code] || _fallbackDef(code);
    const subjectKey = _resolveSubjectKey(opts);
    const organizationId = opts.orgId != null ? String(opts.orgId) : null;
    const severity = SEVERITIES.includes(opts.severity) ? opts.severity : def.severity;
    const message = (typeof opts.message === 'string' && opts.message)
        ? _sanitizeString(opts.message)
        : def.defaultMessage;
    try {
        await _getStore().appendEvent({
            subjectKey, organizationId, code,
            category: def.category, severity,
            actorKind: ACTOR_KINDS.includes(opts.actorKind) ? opts.actorKind : 'system',
            actorUserId: opts.actorUserId != null ? String(opts.actorUserId) : null,
            message,
            meta: _sanitizeMeta(opts.meta),
            ip: _clientIp(opts.req),
        });
    } catch (_) { /* swallow */ }
}

/**
 * Append a lifecycle/timeline event unconditionally (used for ALWAYS_APPEND
 * codes like bootstrap.org_created, onboarding.completed, binding.*).
 * Options: { orgId, ncInstanceId, subjectKey, actorUserId, actorKind, meta, message, severity, req }
 */
function event(code, opts = {}) {
    try {
        return _eventAsync(code, opts || {}).catch(() => { });
    } catch (_) {
        return Promise.resolve();
    }
}

async function _resolveAsync(subjectOrOrgId, codes, { resolvedBy = 'system', appendEvent = true } = {}) {
    const list = (Array.isArray(codes) ? codes : [codes]).filter(Boolean);
    if (!subjectOrOrgId || !list.length) return 0;
    const id = String(subjectOrOrgId);
    let count = 0;
    try {
        count = await _getStore().resolveProblems(id, list, resolvedBy || 'system');
    } catch (_) {
        return 0;
    }
    if (count > 0 && appendEvent !== false) {
        const isBucket = /^(nc:|domain:)/.test(id) || id === 'unknown';
        const byAdmin = resolvedBy && resolvedBy !== 'system';
        try {
            await _getStore().appendEvent({
                subjectKey: id,
                organizationId: isBucket ? null : id,
                code: 'health.resolved',
                category: 'health',
                severity: 'info',
                actorKind: byAdmin ? 'admin' : 'system',
                actorUserId: byAdmin ? String(resolvedBy) : null,
                message: `Resolved: ${list.join(', ')}`,
                meta: { codes: list },
            });
        } catch (_) { /* swallow */ }
    }
    return count;
}

/**
 * Resolve open problems for an org (or bucket subject). Appends one
 * 'health.resolved' timeline event only when rows actually flipped.
 * Returns a promise of the resolved row count (never rejects).
 */
function resolve(subjectOrOrgId, codes, opts) {
    try {
        return _resolveAsync(subjectOrOrgId, codes, opts).catch(() => 0);
    } catch (_) {
        return Promise.resolve(0);
    }
}

// The store caps a listing at 500 rows, newest first, so any subject that
// drops off the end is one that failed longest ago; it simply reads as
// "no recent failure known".
const OPEN_PROBLEM_SCAN_LIMIT = 500;

async function _openProblemLastSeenAsync(code) {
    const out = new Map();
    if (!code) return out;
    let rows = [];
    try {
        rows = await _getStore().listProblems({ code: String(code), limit: OPEN_PROBLEM_SCAN_LIMIT });
    } catch (_) {
        return out;
    }
    for (const p of Array.isArray(rows) ? rows : []) {
        const subject = p && (p.organizationId || p.subjectKey);
        const at = p && p.lastSeenAt ? new Date(p.lastSeenAt).getTime() : NaN;
        if (subject && Number.isFinite(at)) out.set(String(subject), at);
    }
    return out;
}

/**
 * Open problems of one code, as a Map of org id (or bucket subject) → when the
 * problem was last recorded, in epoch ms. Lets a job ask "did this fail
 * recently?" of the rollup it already writes, instead of keeping a column of
 * its own. Never rejects: a failed read answers an empty Map, which callers
 * must read as "no recent failure known".
 */
function openProblemLastSeen(code) {
    try {
        return _openProblemLastSeenAsync(code).catch(() => new Map());
    } catch (_) {
        return Promise.resolve(new Map());
    }
}

async function _touchLivenessAsync(orgId, kind, { connectorVersion } = {}) {
    if (!orgId) return;
    const k = LIVENESS_KINDS.has(kind) ? kind : 'authOk';
    const throttleKey = `${orgId}|${k}`;
    const now = _now();
    const last = _livenessMarks.get(throttleKey);
    if (last != null && (now - last) < LIVENESS_WINDOW_MS) return;
    _livenessMarks.set(throttleKey, now);
    _capMap(_livenessMarks);
    try {
        await _getStore().touchLiveness(String(orgId), { [k]: true, connectorVersion: connectorVersion || null });
    } catch (_) { /* swallow */ }
}

/**
 * Record org liveness ('authOk' | 'bootstrap' | 'statusReport'), throttled
 * in-memory to one DB write per org/kind per 15 minutes — safe on the
 * per-request connectorJwt hot path.
 */
function touchLiveness(orgId, kind = 'authOk', opts = {}) {
    try {
        return _touchLivenessAsync(orgId, kind, opts || {}).catch(() => { });
    } catch (_) {
        return Promise.resolve();
    }
}

module.exports = {
    CODES,
    ALWAYS_APPEND,
    SEVERITIES,
    ACTOR_KINDS,
    problem,
    event,
    resolve,
    openProblemLastSeen,
    touchLiveness,
    clientIp: _clientIp,
    // internal — exported for unit tests
    _sanitizeMeta,
    _resolveSubjectKey,
    _setStore,
    _setNow,
    _resetThrottles,
    _maskEmail,
};
