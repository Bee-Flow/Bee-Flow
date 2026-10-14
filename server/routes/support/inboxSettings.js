/**
 * Tenant Support Inbox: what the settings UI reads, and the live feed.
 * The org-scoped canned replies, tags and insights, the teammates and the
 * integrations an inbox's AI may be granted, the SSE stream, the grouped
 * per-inbox settings, the per-inbox group access and the audit feeds.
 * Split out of routes/supportInbox.js; behaviour unchanged.
 */

const supportInboxStore = require('../../stores/supportInboxStore');
const supportStore = require('../../stores/supportStore');
const { setupSSE, startSseHeartbeat } = require('../../core/http/sseHelpers');
const { validateSharedGroupsForOrg } = require('../../auth/permissions');
const access = require('../../support/access');
const audit = require('../../support/audit');
const { supportEvents } = require('../support');
const { getUserId, resolveOrgScope, loadInboxInScope } = require('./inboxScope');

async function listCanned(req, res) {
    const scope = await resolveOrgScope(req);
    const out = [];
    for (const orgId of scope) out.push(...await supportStore.listCannedResponses(orgId));
    res.json({ canned: out });
}

async function listTags(req, res) {
    const scope = await resolveOrgScope(req);
    const out = [];
    for (const orgId of scope) out.push(...await supportStore.listTags(orgId));
    res.json({ tags: out });
}

async function insights(req, res) {
    const inboxes = await access.accessibleInboxes(req);
    const inboxIds = inboxes.map(i => i.id);
    if (!inboxIds.length) return res.json({});
    const { NOT_SUPPORT_TAG } = require('../../services/supportClassifier');
    const { inbox } = req.query;
    // Optional single-inbox scope (validated like GET /threads); insights
    // always exclude non-support tickets so the numbers reflect real support.
    let opts;
    if (inbox) {
        if (!inboxIds.includes(inbox)) return res.json({});
        opts = { inboxId: inbox };
    } else {
        opts = { inboxIdIn: inboxIds };
    }
    opts.excludeTags = [NOT_SUPPORT_TAG];
    const insights = await supportStore.getInsights(opts);
    res.json(insights);
}

// Eligible teammates for assignment (read-only) — powers the ticket assignee
// picker. Returns the union of in-scope orgs' support-capable staff with names.
async function teammates(req, res) {
    const scope = await resolveOrgScope(req);
    const { _eligibleStaffForOrg } = require('../../services/supportAutoAssigner');
    const userStore = require('../../stores/userStore');
    const seen = new Set();
    const out = [];
    for (const orgId of scope) {
        const ids = await _eligibleStaffForOrg(orgId).catch(() => []);
        for (const id of ids) {
            if (seen.has(id)) continue;
            seen.add(id);
            const u = await userStore.getUser(id).catch(() => null);
            out.push({
                id,
                name: u?.displayName || u?.display_name || u?.name || null,
                email: u?.email || null,
            });
        }
    }
    res.json({ teammates: out });
}

// Integrations the support AI can be GRANTED for this inbox — scoped to what
// the designated operator is actually entitled to (the same gate the compose
// path uses), so "give the AI the integrations that user has access to" is
// literal. The frontend joins these ids with its INTEGRATION_CATALOG for
// labels/icons. Pass ?operator=<userId> to preview a not-yet-saved choice.
async function availableIntegrations(req, res) {
    const inbox = await loadInboxInScope(req, res, req.params.id);
    if (!inbox) return;
    const operatorUserId = String(req.query.operator || inbox.operator_user_id || '').trim() || null;
    if (!operatorUserId) return res.json({ integrations: [], operatorUserId: null });

    const userStore = require('../../stores/userStore');
    const { _eligibleStaffForOrg } = require('../../services/supportAutoAssigner');
    const eligible = await _eligibleStaffForOrg(inbox.organization_id).catch(() => []);
    if (!Array.isArray(eligible) || !eligible.includes(operatorUserId)) {
        return res.status(400).json({ error: "Operator must be a member of this inbox's organisation." });
    }

    // Authoritative: the operator's resolved integration entitlement
    // (ceiling ∩ org grant ∩ per-group). Falls back to the org-admin active
    // list only if the resolver is unavailable.
    let effective = new Set();
    try {
        const entitlements = require('../../core/entitlements/entitlements');
        const snap = await entitlements.resolveEntitlements({ userId: operatorUserId, orgId: inbox.organization_id });
        if (snap && !snap.degraded && Array.isArray(snap.effective?.integration)) {
            effective = new Set(snap.effective.integration);
        }
    } catch (_) { /* fall through */ }
    if (!effective.size) {
        const active = await userStore.getOrgEnabledIntegrations(inbox.organization_id).catch(() => []);
        effective = new Set(Array.isArray(active) ? active : []);
    }

    // Only surface catalog integrations that actually expose agent tools,
    // and never Nextcloud (its own panel + connector own that surface).
    const { TOOL_REGISTRY } = require('../../automation/toolRegistry');
    const toolApps = new Set(TOOL_REGISTRY.map(e => e.app));
    const ids = Array.from(effective)
        .filter(id => typeof id === 'string' && toolApps.has(id) && !id.startsWith('nextcloud'))
        .sort();

    // Webpages is a per-user beta-feature capability, not an org/entitlement
    // integration, so it never lands in `effective`/org-enabled above. Offer
    // it as a grantable integration when the operator genuinely has webpage
    // access — the SAME gate the runtime uses (core/integrationTools →
    // WEBPAGE_AUTOMATION_TOOLS): the `webpages` beta feature, or a webpage
    // they own / that is shared into their org/group. This keeps the picker
    // in parity with what _resolveOperatorIntegrations will actually grant,
    // giving the support AI the exact webpage tools an agent gets in a normal
    // (non-in-editor) chat. Fail closed: any probe error leaves it out.
    try {
        if (toolApps.has('webpages') && !ids.includes('webpages')) {
            const { userHasBetaFeature } = require('../../core/entitlements/betaFeatures');
            let webpagesOk = await userHasBetaFeature(operatorUserId, 'webpages').catch(() => false);
            if (!webpagesOk) {
                const op = await userStore.getUser(operatorUserId).catch(() => null);
                const groupIds = Array.isArray(op?.groups) ? op.groups : [];
                const webpageStore = require('../../stores/webpageStore');
                webpagesOk = await webpageStore
                    .userHasAnyWebpageAccess(operatorUserId, groupIds, inbox.organization_id ? [inbox.organization_id] : [])
                    .catch(() => false);
            }
            if (webpagesOk) { ids.push('webpages'); ids.sort(); }
        }
    } catch (_) { /* webpages probe failed — leave it out */ }

    res.json({ integrations: ids, operatorUserId });
}

async function stream(req, res) {
    let listener = null, heartbeat = null, markEnded = () => {};
    let cleaned = false;
    const cleanup = () => {
        if (cleaned) return; cleaned = true;
        try { if (heartbeat) heartbeat(); } catch {}
        try { if (listener) supportEvents.off('event', listener); } catch {}
        try { markEnded(); } catch {}
    };
    try {
        const inboxes = await access.accessibleInboxes(req);
        const inboxIds = new Set(inboxes.map(i => i.id));
        const sse = setupSSE(res);
        markEnded = sse.markEnded;
        sse.sendEvent('ready', { at: Date.now() });
        listener = ({ event, data }) => {
            // Only forward events for inboxes this caller can see.
            if (!data || !data.inboxId || !inboxIds.has(data.inboxId)) return;
            try { sse.sendEvent(event, { ...data, at: Date.now() }); } catch { cleanup(); }
        };
        supportEvents.on('event', listener);
        // unref'd heartbeat + 3-strike liveness (reaps half-closed sockets).
        heartbeat = startSseHeartbeat(res, 25000, { frame: ': ping\n\n', onDead: cleanup });
        req.on('close', cleanup); req.on('error', cleanup); res.on('error', cleanup);
    } catch (err) {
        cleanup();
        if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
    }
}

function inboxToSettings(inbox) {
    return {
        general: {
            display_name: inbox.display_name || '',
            provider: inbox.provider,
            email_address: inbox.email_address || null,
            connected: !!inbox.connected,
            default_agent_id: inbox.default_agent_id || null,
            kb_ids: Array.isArray(inbox.kb_ids) ? inbox.kb_ids : [],
        },
        ai: {
            reply_mode: inbox.reply_mode || 'draft',
            autoresolve_threshold: Number(inbox.autoresolve_threshold) || 0.78,
            signature: inbox.signature || '',
            enabled_tool_ids: Array.isArray(inbox.enabled_tool_ids) ? inbox.enabled_tool_ids : [],
            operator_user_id: inbox.operator_user_id || null,
        },
        classification: {
            classify_non_support_enabled: !!inbox.classify_non_support_enabled,
            classify_sensitivity: Number(inbox.classify_sensitivity) || 0.85,
            classify_suppress_autoreply: inbox.classify_suppress_autoreply !== false,
        },
        kbIngest: {
            enabled: !!inbox.kb_ingest_enabled,
            kb_id: inbox.kb_ingest_kb_id || null,
            automation_id: inbox.kb_ingest_automation_id || null,
        },
        access: {
            shared_groups: Array.isArray(inbox.shared_groups) ? inbox.shared_groups : [],
        },
        scan: {
            scan_status: inbox.scan_status,
            scan_result: inbox.scan_result || null,
        },
    };
}

// Resolve which support-capable members an access list grants the inbox to.
// Empty groups → all eligible org staff; non-empty → eligible staff in a granted
// group. Capped so a huge org never blows up the response.
async function _resolveAccessMembers(inbox, sharedGroups) {
    try {
        const userStore = require('../../stores/userStore');
        const { _eligibleStaffForOrg } = require('../../services/supportAutoAssigner');
        const eligible = await _eligibleStaffForOrg(inbox.organization_id).catch(() => []);
        let memberIds = Array.isArray(eligible) ? eligible : [];
        if (Array.isArray(sharedGroups) && sharedGroups.length) {
            const filtered = [];
            for (const id of memberIds) {
                const g = await access.userGroupsFor(id);
                if (g.some(x => sharedGroups.includes(x))) filtered.push(id);
            }
            memberIds = filtered;
        }
        const out = [];
        for (const id of memberIds.slice(0, 50)) {
            const u = await userStore.getUser(id).catch(() => null);
            out.push({ id, name: u?.displayName || u?.display_name || u?.name || null, email: u?.email || null });
        }
        return out;
    } catch { return []; }
}

async function inboxSettings(req, res) {
    const inbox = await loadInboxInScope(req, res, req.params.id);
    if (!inbox) return;
    res.json({ inbox, settings: inboxToSettings(inbox) });
}

async function getAccess(req, res) {
    const inbox = await loadInboxInScope(req, res, req.params.id);
    if (!inbox) return;
    const userStore = require('../../stores/userStore');
    const allGroups = await userStore.getAllGroups().catch(() => []);
    const availableGroups = (Array.isArray(allGroups) ? allGroups : [])
        .filter(g => g.organizationId === inbox.organization_id)
        .map(g => ({ id: g.id, name: g.name }));
    const sharedGroups = Array.isArray(inbox.shared_groups) ? inbox.shared_groups : [];
    const resolvedMembers = await _resolveAccessMembers(inbox, sharedGroups);
    res.json({
        mode: sharedGroups.length ? 'groups' : 'everyone',
        sharedGroups, availableGroups, resolvedMembers,
    });
}

async function putAccess(req, res) {
    const inbox = await loadInboxInScope(req, res, req.params.id);
    if (!inbox) return;
    // Only org admins (or super admins / the inbox owner) may change access —
    // org admins always pass loadInboxInScope, so an inbox can't be locked
    // away from its own org's admins.
    const isOrgAdmin = await access.resolveIsOrgAdmin(req);
    const { orgIds } = await access.resolveOrgScope(req);
    const isOwner = inbox.created_by && inbox.created_by === getUserId(req);
    if (!(isOrgAdmin || orgIds === null || isOwner)) {
        return res.status(403).json({ error: 'Only an organisation admin can change inbox access.' });
    }
    let groups;
    try {
        groups = await validateSharedGroupsForOrg(inbox.organization_id, req.body.sharedGroups);
    } catch (err) {
        // Its refusals carry a status; a database failure does not and is a 500.
        if (err?.status) return res.status(err.status).json({ error: err.message });
        throw err;
    }
    const updated = await supportInboxStore.setSharedGroups(req.params.id, groups || [], inbox.organization_id);
    audit.emit(req, { organizationId: inbox.organization_id, inboxId: inbox.id, action: 'inbox_access_changed', payload: { sharedGroups: groups || [] } });
    const resolvedMembers = await _resolveAccessMembers(updated, updated.shared_groups || []);
    res.json({
        mode: (groups && groups.length) ? 'groups' : 'everyone',
        sharedGroups: updated.shared_groups || [], resolvedMembers, inbox: updated,
    });
}

async function inboxAudit(req, res) {
    const inbox = await loadInboxInScope(req, res, req.params.id);
    if (!inbox) return;
    const { actor, action, from, to, cursor, limit } = req.query;
    const out = await supportStore.listAuditEvents({
        inboxId: inbox.id,
        actorKind: actor || undefined, action: action || undefined,
        since: from || undefined, until: to || undefined,
        cursor: cursor || undefined, limit: limit ? parseInt(limit, 10) : 50,
    });
    res.json(out);
}

// Org-wide audit feed. Restricted to the caller's accessible inboxes plus
// config events (inbox_id IS NULL) within their org scope — a forbidden inbox's
// events can never leak here.
async function orgAudit(req, res) {
    const inboxes = await access.accessibleInboxes(req);
    const inboxIds = inboxes.map(i => i.id);
    const { scope } = await access.resolveOrgScope(req);
    const { inbox, actor, action, from, to, cursor, limit } = req.query;
    let inboxIdIn = inboxIds;
    if (inbox) {
        if (!inboxIds.includes(inbox)) return res.json({ events: [], nextCursor: null });
        inboxIdIn = [inbox];
    }
    const out = await supportStore.listAuditEvents({
        organizationIdIn: scope,
        inboxIdIn,
        actorKind: actor || undefined, action: action || undefined,
        since: from || undefined, until: to || undefined,
        cursor: cursor || undefined, limit: limit ? parseInt(limit, 10) : 50,
    });
    res.json(out);
}

module.exports = { listCanned, listTags, insights, teammates, availableIntegrations, stream, inboxSettings, getAccess, putAccess, inboxAudit, orgAudit };
