/**
 * Compliance EventEmitter — turns business events into compliance signals.
 *
 * Producers `emit()` semantic events from where they happen (guardrail toggle,
 * integration call to non-EU, agent publish, DSR submitted). Consumers re-run
 * the relevant check and post a notification so admins see the impact without
 * waiting for the 6-hour scheduler sweep.
 *
 * Producers stay decoupled — they never reach into runner/notificationStore
 * directly. This file is the single coupling point and the only place that
 * needs to know which check to re-run for which event.
 */

const { EventEmitter } = require('events');
const { complianceSectionPath, complianceIncidentPath } = require('../utils/appPaths');
const log = require('../telemetry/log');

const _bus = new EventEmitter();
_bus.setMaxListeners(50);

// Lazy requires to avoid circular deps (runner -> checks -> events on cold boot).
let _runner = null;
let _notificationStore = null;
function _lazyRunner() {
    if (!_runner) _runner = require('./runner');
    return _runner;
}
function _lazyNotifications() {
    if (_notificationStore === null) {
        try { _notificationStore = require('../stores/notificationStore'); }
        catch { _notificationStore = false; }
    }
    return _notificationStore || null;
}

const EVENTS = {
    DLP_CONFIG_CHANGED: 'dlp_config_changed',
    EXTERNAL_TRANSFER_DETECTED: 'external_transfer_detected',
    AGENT_PUBLISHED: 'agent_published',
    DSR_SUBMITTED: 'dsr_submitted',
    // Early breach signal (e.g. bulk-decrypt anomaly). Creates a DRAFT incident
    // in the Art-33 registry for a human to assess — never auto-notifies anyone
    // outside the org.
    BREACH_SIGNAL: 'breach_signal',
    // An ISO evidence connector observed a changed snapshot hash (external
    // system config drifted) — re-run exactly the checks that read it.
    CONTROL_DRIFT: 'control_drift',
    // Per-org framework state changed (frameworkPolicy emits these by string —
    // the names here MUST stay equal to frameworkPolicy.POLICY_EVENTS).
    FRAMEWORK_ENABLED: 'framework_enabled',
    FRAMEWORK_DISABLED: 'framework_disabled',
    FRAMEWORK_RELEVANCE_CHANGED: 'framework_relevance_changed',
    // An admin recorded an AI Act self-assessment for an automation or agent.
    AI_ACT_ATTESTED: 'ai_act_attested',
    // The org-wide "mark AI-generated documents" switch flipped.
    CONTENT_MARKING_CHANGED: 'content_marking_changed',
    // DSR lifecycle — the Art. 15/17 checks read the register.
    DSR_EXTENDED: 'dsr_extended',
    DSR_FULFILLED: 'dsr_fulfilled',
    // A CRA early warning / full report was stamped on a vulnerability.
    CRA_VULNERABILITY_REPORTED: 'cra_vulnerability_reported',
};

// Best-effort: the counts endpoint caches 60 s per org; anything that changes
// a number it shows drops the cache so the rail catches up on the next poll.
function _invalidateCounts(orgId) {
    try { require('./countsCache').invalidate(orgId); } catch { /* not mounted */ }
}

// Re-run one check; a FrameworkDisabledError (409) is a normal outcome here —
// the framework was switched off between the event and the handler.
async function _rerun(orgId, checkId, opts = {}) {
    try { await _lazyRunner().runOne(orgId, checkId, { runType: 'event', ...opts }); }
    catch (e) { if (e?.status !== 409) log.warn(`[ComplianceEvents] rerun ${checkId} failed:`, e.message); }
}

function emit(eventName, payload = {}) {
    try {
        _bus.emit(eventName, payload || {});
    } catch (e) {
        log.warn('[ComplianceEvents] emit error:', e.message);
    }
}

async function _notifyAdmins(orgId, category, title, message, link = null) {
    const store = _lazyNotifications();
    if (!store?.createNotification) return;
    try {
        const { getAll } = require('../db');
        const rows = await getAll(
            // 'org_admin' is canonical; legacy 'admin' kept for orgs that
            // pre-date the rename (matches permissions.js normalisation).
            `SELECT id FROM users WHERE "organizationId" = $1 AND (role = 'admin' OR "orgRole" IN ('org_admin', 'admin'))`,
            [orgId],
        );
        for (const u of rows || []) {
            await store.createNotification({ userId: u.id, category, title, message, link }).catch(() => {});
        }
    } catch (e) {
        log.warn('[ComplianceEvents] notify failed:', e.message);
    }
}

// ─────────────── Wiring ───────────────
//
// All handlers are fire-and-forget. They never throw upstream — emitters keep
// running even if compliance is offline.

_bus.on(EVENTS.DLP_CONFIG_CHANGED, async ({ orgId }) => {
    if (!orgId) return;
    try { await _lazyRunner().runOne(orgId, 'GDPR-Art32-dlp-enabled', { runType: 'event' }); }
    catch (e) { log.warn('[ComplianceEvents] DLP rerun failed:', e.message); }
});

_bus.on(EVENTS.EXTERNAL_TRANSFER_DETECTED, async ({ orgId, operator, country_code }) => {
    if (!orgId) return;
    try { await _lazyRunner().runOne(orgId, 'GDPR-Art44-external-transfers', { runType: 'event' }); }
    catch (e) { log.warn('[ComplianceEvents] Art44 rerun failed:', e.message); }
    await _notifyAdmins(
        orgId,
        'heads_up',
        'External data transfer detected',
        `An integration call routed to ${operator || 'an external operator'}${country_code ? ` (${country_code})` : ''}. Confirm SCCs are in place under Compliance → ROPA.`,
        complianceSectionPath('ropa'),
    );
});

_bus.on(EVENTS.AGENT_PUBLISHED, async ({ orgId, agentId }) => {
    if (!orgId) return;
    try {
        await _lazyRunner().runOne(orgId, 'AIA-Art50-ai-disclosure', { runType: 'event' });
    } catch (e) { log.warn('[ComplianceEvents] Art50 rerun failed:', e.message); }
    try {
        await _lazyRunner().runOne(orgId, 'GDPR-Art35-dpia-high-risk', { runType: 'event', subjectId: agentId });
    } catch (e) { log.warn('[ComplianceEvents] Art35 rerun failed:', e.message); }
});

_bus.on(EVENTS.DSR_SUBMITTED, async ({ orgId, requestType }) => {
    if (!orgId) return;
    const checkId = requestType === 'deletion'
        ? 'GDPR-Art17-dsr-deletion'
        : 'GDPR-Art15-dsr-access';
    try { await _lazyRunner().runOne(orgId, checkId, { runType: 'event' }); }
    catch (e) { log.warn('[ComplianceEvents] DSR rerun failed:', e.message); }
    await _notifyAdmins(
        orgId,
        'urgent',
        'New data-subject request',
        `A ${requestType || 'data-subject'} request was submitted. GDPR requires fulfilment within 30 days. Open Compliance → DSR Inbox to respond.`,
        complianceSectionPath('dsr'),
    );
});

_bus.on(EVENTS.CONTROL_DRIFT, async ({ orgId, connectorId, checkIds }) => {
    if (!orgId || !Array.isArray(checkIds) || !checkIds.length) return;
    for (const checkId of checkIds) {
        try { await _lazyRunner().runOne(orgId, checkId, { runType: 'event' }); }
        catch (e) { log.warn(`[ComplianceEvents] drift rerun ${checkId} failed:`, e.message); }
    }
    await _notifyAdmins(
        orgId,
        'heads_up',
        'External system configuration changed',
        `The ${connectorId || 'evidence'} connector observed a changed configuration in a coupled system. The linked ISO 27001 checks were re-run — review the result under ISO 27001 → Controls.`,
        complianceSectionPath('iso_controls'),
    );
});

_bus.on(EVENTS.BREACH_SIGNAL, async ({ orgId, userId, summary, source }) => {
    try {
        // Producers that only know the user (decrypt audit) let us resolve the org.
        let org = orgId;
        if (!org && userId) {
            try {
                const userStore = require('../stores/userStore');
                const u = await userStore.getUser(userId);
                org = u?.organizationId || 'default';
            } catch { org = 'default'; }
        }
        if (!org) return;
        const incidentStore = require('../stores/incidentStore');
        const src = source || 'signal';
        // One draft per signal source per day — a burst of anomaly alerts must
        // not flood the registry.
        if (await incidentStore.hasRecentAutoIncident(org, src, 24)) return;
        const incident = await incidentStore.createIncident({
            organization_id: org,
            title: summary ? String(summary).slice(0, 200) : 'Anomalous data access detected',
            description: `Automatically created from a ${src} signal${userId ? ` (user ${userId})` : ''}. Assess whether this is a personal-data breach; if so, the supervisory authority must be notified within 72 hours (Art. 33).`,
            severity: 'high',
            source: src,
            created_by: null,
        });
        try { await _lazyRunner().runOne(org, 'GDPR-Art33-breach-detection', { runType: 'event' }); }
        catch (e) { log.warn('[ComplianceEvents] Art33 rerun failed:', e.message); }
        await _notifyAdmins(
            org,
            'urgent',
            'Possible data incident — assessment needed',
            'An anomalous data-access pattern was detected and a draft incident was created. Assess it now: if personal data is affected, the 72-hour Art. 33 clock is already running.',
            complianceIncidentPath(incident?.id || ''),
        );
    } catch (e) {
        log.warn('[ComplianceEvents] breach signal failed:', e.message);
    }
});

// ─────────────── Frameworks ───────────────
//
// The route that enables a framework awaits runner.runFramework itself (so
// the response carries a fresh score) — the handler only tells the admins and
// drops the counts cache. A `run:true` in the payload asks the handler to run
// the sweep for emitters without a response to fill (CLI, migrations).

_bus.on(EVENTS.FRAMEWORK_ENABLED, async ({ orgId, frameworkId, run }) => {
    if (!orgId || !frameworkId) return;
    if (run === true) {
        try { await _lazyRunner().runFramework(orgId, frameworkId, { runType: 'event' }); }
        catch (e) { log.warn(`[ComplianceEvents] framework ${frameworkId} sweep failed:`, e.message); }
    }
    _invalidateCounts(orgId);
    await _notifyAdmins(
        orgId,
        'heads_up',
        'Framework enabled',
        `A compliance framework was enabled for your organisation and its checks were run for the first time. Review the results under Compliance → Frameworks.`,
        complianceSectionPath('frameworks'),
    );
});

_bus.on(EVENTS.FRAMEWORK_DISABLED, async ({ orgId }) => {
    if (!orgId) return;
    _invalidateCounts(orgId);
});

_bus.on(EVENTS.FRAMEWORK_RELEVANCE_CHANGED, async ({ orgId }) => {
    if (!orgId) return;
    _invalidateCounts(orgId);
});

// ─────────────── AI Act ───────────────

_bus.on(EVENTS.AI_ACT_ATTESTED, async ({ orgId, targetKind, targetId }) => {
    if (!orgId) return;
    await _rerun(orgId, 'AIA-Art53-model-inventory');
    if (targetKind === 'automation' && targetId) {
        await _rerun(orgId, 'AIA-Art50-content-marking', { subjectId: targetId });
    }
    _invalidateCounts(orgId);
});

_bus.on(EVENTS.CONTENT_MARKING_CHANGED, async ({ orgId }) => {
    if (!orgId) return;
    await _rerun(orgId, 'AIA-Art50-content-marking');
    _invalidateCounts(orgId);
});

// ─────────────── DSR lifecycle ───────────────
//
// Payloads carry the request id and type only — never the subject's e-mail.

function _dsrCheckId(requestType) {
    return requestType === 'deletion' ? 'GDPR-Art17-dsr-deletion' : 'GDPR-Art15-dsr-access';
}

_bus.on(EVENTS.DSR_EXTENDED, async ({ orgId, requestType }) => {
    if (!orgId) return;
    await _rerun(orgId, _dsrCheckId(requestType));
    _invalidateCounts(orgId);
});

_bus.on(EVENTS.DSR_FULFILLED, async ({ orgId, requestType }) => {
    if (!orgId) return;
    await _rerun(orgId, _dsrCheckId(requestType));
    _invalidateCounts(orgId);
});

// ─────────────── CRA ───────────────

_bus.on(EVENTS.CRA_VULNERABILITY_REPORTED, async ({ orgId }) => {
    if (!orgId) return;
    let checks = [];
    try { checks = require('./registry').getPrimary('CRA') || []; } catch { checks = []; }
    for (const c of checks) await _rerun(orgId, c.id);
    _invalidateCounts(orgId);
});

module.exports = { emit, EVENTS, _bus };
