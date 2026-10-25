// @typecheck noImplicitAny
/**
 * Tenant Support Inbox API (Studio → Support).
 *
 * A NON-global-admin org runs its own customer-support desk here: connect a
 * support mailbox (Gmail/Outlook), inbound email becomes tickets, and replies
 * are drafted by an agent + knowledge base and sent from the connected mailbox.
 *
 * Hard tenancy boundary: every route resolves the caller's org(s) and only ever
 * touches support_threads WHERE inbox_id IS NOT NULL belonging to those orgs.
 * Bee Flow's own company inbox (/api/support, inbox_id IS NULL) is unreachable
 * from here, and the company inbox excludes inbox_id-set tenant threads.
 *
 * Every body and query is a closed schema (routes/support/inboxSchemas.js),
 * checked after the permission gate. The OAuth callback and the SSE stream
 * keep none: the provider's redirect carries its own parameters, and the
 * stream reads nothing.
 *
 * Mounted (server/index.js) behind requireLicenseFeature('support_inbox') +
 * requireBetaFeature('support_inbox'); the org-level 'support_inbox' permission
 * is enforced per-route below.
 */

const express = require('express');
const router = express.Router();

const supportInboxStore = require('../stores/supportInboxStore');
const access = require('../support/access');
const audit = require('../support/audit');
const { validate } = require('../core/http/validate');
const S = require('./support/inboxSchemas');
const agentStore = require('../stores/agentStore');
// Who the caller is and what they may reach (the scope and ACL helpers every
// route funnels through), then the handler bodies of the routes registered at
// the bottom of this file. This file keeps the gate, the inbox CRUD, the KB
// automation and the scan, and the route table in its order.
const { getUserId, _hasSupportInbox, resolveOrgScope, loadInboxInScope } = require('./support/inboxScope');
const OAuth = require('./support/inboxOAuth');
const Threads = require('./support/inboxThreads');
const Settings = require('./support/inboxSettings');
const Writes = require('./support/inboxOrgWrites');
const { fallback, bestEffort } = require('../utils/bestEffort');

// ── Permission gate (all routes) ──────────────────────────────────────────────
router.use(async (req, res, next) => {
    if (!getUserId(req)) return res.status(401).json({ error: 'Not authenticated' });
    if (!(await _hasSupportInbox(req))) {
        return res.status(403).json({ error: 'support_inbox permission required' });
    }
    next();
});

// ── Inbox CRUD ────────────────────────────────────────────────────────────────

/**
 * May this inbox's AI run `agentId`? The responder runs the agent's prompt
 * and tools on the inbox's tickets and never re-checks whose agent it is, so
 * the check is here: an agent of the inbox's own organisation, a personal
 * agent of the caller with no organisation, or a system agent. Before this
 * any agent id was stored, another tenant's included, and its system prompt
 * and pinned tool parameters then drafted this tenant's replies.
 * @param {string | null | undefined} agentId
 * @param {string} organizationId
 * @param {ReturnType<typeof getUserId>} userId
 */
async function agentUsableByInbox(agentId, organizationId, userId) {
    if (!agentId) return true;
    const agent = await agentStore.getAgent(agentId).catch((e) => fallback('routes/supportInbox:agentUsableByInbox', e, null));
    if (!agent) return false;
    if (agent.owner_id === 'system') return true;
    if (agent.organization_id) return agent.organization_id === organizationId;
    return agent.owner_id === userId;
}
const AGENT_REFUSED = { error: "That agent is not available to this inbox's organisation.", code: 'agent_not_available' };

router.get('/inboxes', async (req, res) => {
    const inboxes = await access.accessibleInboxes(req);
    res.json({ inboxes });
});

router.post('/inboxes', validate({ body: S.CreateInboxBody }), async (req, res) => {
    const scope = await resolveOrgScope(req);
    const organizationId = req.body.organizationId || scope[0];
    if (!organizationId || !scope.includes(organizationId)) {
        return res.status(403).json({ error: 'No organization in scope' });
    }
    const { provider, displayName, defaultAgentId, kbIds, replyMode, autoresolveThreshold, toolsEnabled, signature, folderFilter } = req.body;
    if (!['gmail', 'outlook'].includes(provider)) return res.status(400).json({ error: 'provider must be gmail or outlook' });
    if (!(await agentUsableByInbox(defaultAgentId, organizationId, getUserId(req)))) return res.status(400).json(AGENT_REFUSED);
    const inbox = await supportInboxStore.createInbox({
        organizationId, createdBy: getUserId(req), provider,
        displayName: displayName || '', defaultAgentId: defaultAgentId || null,
        kbIds: Array.isArray(kbIds) ? kbIds : [],
        replyMode: ['draft', 'auto_confident', 'autonomous'].includes(replyMode) ? replyMode : 'draft',
        autoresolveThreshold: autoresolveThreshold != null ? Number(autoresolveThreshold) : 0.78,
        toolsEnabled: !!toolsEnabled, signature: signature || null,
        folderFilter: Array.isArray(folderFilter) ? folderFilter : ['INBOX'],
    });
    audit.emit(req, { organizationId, inboxId: inbox.id, action: 'inbox_created', payload: { provider, displayName: inbox.display_name || null } });
    res.json({ inbox });
});

router.patch('/inboxes/:id', validate({ body: S.PatchInboxBody }), async (/** @type {import('express').Request<{ id: string }>} */ req, /** @type {import('express').Response} */ res) => {
    const inbox = await loadInboxInScope(req, res, req.params.id);
    if (!inbox) return;
    if (!(await agentUsableByInbox(req.body.default_agent_id, inbox.organization_id, getUserId(req)))) return res.status(400).json(AGENT_REFUSED);
    // A designated operator must be support-capable staff in THIS inbox's
    // org: integration tools execute under their identity, so a cross-org
    // operator would expose another org's credentials/entitlements. Empty
    // string / null clears the operator (allowed).
    if (typeof req.body?.operator_user_id === 'string' && req.body.operator_user_id.trim()) {
        const { _eligibleStaffForOrg } = require('../services/supportAutoAssigner');
        const eligible = await _eligibleStaffForOrg(inbox.organization_id).catch((e) => fallback('routes/supportInbox:anon', e, []));
        const op = req.body.operator_user_id.trim();
        if (!Array.isArray(eligible) || !eligible.includes(op)) {
            return res.status(400).json({ error: "Operator must be a support-capable member of this inbox's organisation." });
        }
        // When the inbox is group-restricted, the operator must also belong to
        // a group that has access — its integrations execute under their
        // identity, so the operator must be a legitimate worker of this inbox.
        const groups = Array.isArray(inbox.shared_groups) ? inbox.shared_groups : [];
        if (groups.length) {
            const opGroups = await access.userGroupsFor(op);
            if (!opGroups.some(/** @param {string} g */ g =>groups.includes(g))) {
                return res.status(400).json({ error: 'Operator must belong to a group that has access to this inbox.' });
            }
        }
        req.body.operator_user_id = op;
    } else if (req.body && (req.body.operator_user_id === '' )) {
        req.body.operator_user_id = null; // explicit clear
    }
    // shared_groups is access-controlled — only the dedicated /access endpoint
    // may change it; the schema refuses it here by name.
    const changedKeys = Object.keys(req.body || {});
    const updated = await supportInboxStore.updateInbox(req.params.id, req.body, inbox.organization_id);
    audit.emit(req, { organizationId: inbox.organization_id, inboxId: inbox.id, action: 'inbox_settings_changed', payload: { changed: changedKeys } });
    res.json({ inbox: updated });
});

// Unlink the mailbox but keep the inbox: tokens are shredded, syncing stops,
// and the tickets this mailbox produced are purged. The inbox row survives so
// its agent/KB/access settings are still there when someone reconnects.
router.post('/inboxes/:id/disconnect', async (req, res) => {
    const inbox = await loadInboxInScope(req, res, req.params.id);
    if (!inbox) return;
    const { ok, purgedThreads } = await supportInboxStore.disconnectInbox(req.params.id, inbox.organization_id);
    if (!ok) return res.status(404).json({ error: 'Inbox not found' });
    audit.emit(req, {
        organizationId: inbox.organization_id, inboxId: inbox.id, action: 'inbox_disconnected',
        payload: { provider: inbox.provider, emailAddress: inbox.email_address || null, purgedThreads },
    });
    res.json({ ok: true, purgedThreads, inbox: await supportInboxStore.getInbox(req.params.id) });
});

router.delete('/inboxes/:id', async (req, res) => {
    const inbox = await loadInboxInScope(req, res, req.params.id);
    if (!inbox) return;
    // Tear down the per-inbox KB-ingestion automation first so it can't keep
    // firing on a dead inbox_id filter after the mailbox is gone.
    if (inbox.kb_ingest_automation_id) {
        const { teardownAutomation } = require('../automation/provisionAutomation');
        await teardownAutomation(inbox.kb_ingest_automation_id).catch((e) => bestEffort('routes/supportInbox:anon#2', e));
    }
    const { purgedThreads } = await supportInboxStore.deleteInbox(req.params.id, inbox.organization_id);
    audit.emit(req, { organizationId: inbox.organization_id, inboxId: inbox.id, action: 'inbox_deleted', payload: { provider: inbox.provider, emailAddress: inbox.email_address || null, purgedThreads } });
    res.json({ ok: true, purgedThreads });
});

// ── KB ingestion: provision/enable/disable the resolved-tickets→KB automation ────
// straight from the Support settings panel (no trip to Automations).

/**
 * Build (or update) the per-inbox "resolved tickets → KB" automation from the
 * support-ticket-to-kb template, bound to this inbox + chosen KB, and activate
 * it. Idempotent: re-uses the stored automation id when present. Returns the
 * automation id + any non-blocking warnings.
 * @param {Awaited<ReturnType<typeof loadInboxInScope>>} inbox
 * @param {ReturnType<typeof getUserId>} userId
 * @param {import('express').Request['session']} session
 * @param {string} kbId
 */
async function ensureKbAutomation(inbox, userId, session, kbId) {
    const templates = require('../automation/templates');
    const automationStore = require('../stores/automationStore');
    const { activateAutomation } = require('../automation/provisionAutomation');
    const { syncKbSources } = require('../core/kb/kbSourceSync');

    const tmpl = templates.getTemplate('support-ticket-to-kb');
    if (!tmpl) throw new Error('KB-ingestion template not found');
    const def = JSON.parse(JSON.stringify(tmpl.definition));
    // Bind the trigger to THIS inbox so the automation only fires for its tickets.
    def.trigger.appEvent = def.trigger.appEvent || {};
    def.trigger.appEvent.filter = { ...(def.trigger.appEvent.filter || {}), inboxId: inbox.id };
    // Fill the KB on the ingest step. Since K10 that step is a first-class
    // `knowledge_write`, which carries the base on the step itself rather than
    // in `inputs` — the legacy `knowledge_base_ingest` action is still matched
    // so an automation provisioned before the migration keeps working when this
    // panel re-saves it.
    const ingestStep = (def.steps || []).find(/** @param {{ type?: string, tool?: string }} s */ s => s.type === 'knowledge_write' || s.tool === 'knowledge_base_ingest');
    if (!ingestStep) throw new Error('KB-ingestion template is missing its ingest step');
    if (ingestStep.type === 'knowledge_write') {
        ingestStep.knowledgeBaseId = kbId;
    } else {
        ingestStep.inputs = ingestStep.inputs || {};
        ingestStep.inputs.knowledgeBaseId = { kind: 'literal', value: kbId };
    }

    let automationId = inbox.kb_ingest_automation_id || null;
    const existing = automationId ? await automationStore.getAutomation(automationId).catch((e) => fallback('routes/supportInbox:ensureKbAutomation', e, null)) : null;
    if (existing) {
        // goLive: this provisioned automation runs what Support settings wrote
        // (handoff 5 live split), never a pending working copy.
        await automationStore.updateAutomation(automationId, { definition: def, triggerType: 'app_event', isDraft: false }, userId, { goLive: true });
    } else {
        const created = await automationStore.createAutomation({
            userId, organizationId: inbox.organization_id,
            title: `Support → KB: ${inbox.email_address || inbox.display_name || inbox.provider}`,
            description: 'Auto-provisioned from Support settings — distils resolved tickets into the knowledge base.',
            definition: def, triggerType: 'app_event',
        });
        automationId = created.id;
    }
    // This path creates and updates an automation WITHOUT going through
    // PUT /api/automation/:id, so it has to reconcile the knowledge-base
    // sources itself — and it is the one automation whose whole purpose is to
    // write to a base, so a missing source here is the most visible miss there
    // is. Never fails the provisioning: the source is bookkeeping.
    await syncKbSources(automationId, def, { userId, title: `Support → KB: ${inbox.email_address || inbox.display_name || inbox.provider}` });
    const { warnings } = await activateAutomation(automationId, { userId, session, isAdmin: !!session?.isAdmin });
    return { automationId, warnings };
}

router.put('/inboxes/:id/kb-automation', validate({ body: S.KbAutomationBody }), async (/** @type {import('express').Request<{ id: string }>} */ req, /** @type {import('express').Response} */ res) => {
    const inbox = await loadInboxInScope(req, res, req.params.id);
    if (!inbox) return;
    const userId = getUserId(req);
    const enabled = !!req.body.enabled;
    const { teardownAutomation } = require('../automation/provisionAutomation');

    if (!enabled) {
        if (inbox.kb_ingest_automation_id) await teardownAutomation(inbox.kb_ingest_automation_id).catch((e) => bestEffort('routes/supportInbox:anon#3', e));
        // Keep kb id so re-enabling pre-selects the previous KB.
        const updated = await supportInboxStore.setKbAutomation(req.params.id, { enabled: false, automationId: null }, inbox.organization_id);
        audit.emit(req, { organizationId: inbox.organization_id, inboxId: inbox.id, action: 'kb_automation_changed', payload: { enabled: false } });
        return res.json({ inbox: updated });
    }

    const knowledgeBaseId = req.body.knowledgeBaseId;
    if (!knowledgeBaseId) return res.status(400).json({ error: 'knowledgeBaseId is required to enable knowledge ingestion.' });
    // Validate the KB is in this org and not a system KB.
    const knowledgeBases = require('../stores/knowledgeBases');
    const kb = await knowledgeBases.getKB(knowledgeBaseId);
    if (!kb) return res.status(400).json({ error: 'Knowledge base not found.' });
    if (kb.tenant_id === 'system') return res.status(400).json({ error: 'Cannot ingest into a system knowledge base.' });
    if (kb.organization_id && kb.organization_id !== inbox.organization_id) {
        return res.status(403).json({ error: 'Knowledge base does not belong to this organisation.' });
    }

    let provisioned;
    try {
        provisioned = await ensureKbAutomation(inbox, userId, req.session, knowledgeBaseId);
    } catch (e) {
        // Activation/validation failure — do NOT mark enabled (keep state consistent).
        return res.status(400).json({ error: /** @type {Error} */ (e).message, details: e.details || null });
    }
    const updated = await supportInboxStore.setKbAutomation(
        req.params.id, { enabled: true, kbId: knowledgeBaseId, automationId: provisioned.automationId }, inbox.organization_id
    );
    audit.emit(req, { organizationId: inbox.organization_id, inboxId: inbox.id, action: 'kb_automation_changed', payload: { enabled: true, knowledgeBaseId, automationId: provisioned.automationId } });
    res.json({ inbox: updated, automationId: provisioned.automationId, warnings: provisioned.warnings || [] });
});

// ── Historical response-time scan (aggregate-only, on-demand) ─────────────────

router.post('/inboxes/:id/scan', validate({ body: S.ScanBody }), async (/** @type {import('express').Request<{ id: string }>} */ req, /** @type {import('express').Response} */ res) => {
    const inbox = await loadInboxInScope(req, res, req.params.id);
    if (!inbox) return;
    if (!inbox.connected) return res.status(400).json({ error: 'Connect the mailbox before scanning.' });
    if (['queued', 'running'].includes(inbox.scan_status)) {
        return res.status(409).json({ error: 'A scan is already in progress.', scan_status: inbox.scan_status });
    }
    const { DEFAULT_WINDOW_DAYS, scanOneDue } = require('../services/supportInboxScanEngine');
    let days = parseInt(req.body?.windowDays, 10);
    if (!Number.isFinite(days) || days < 1) days = DEFAULT_WINDOW_DAYS;
    days = Math.min(days, 730);
    const scanAfter = new Date(Date.now() - days * 86400000).toISOString();
    const updated = await supportInboxStore.queueScan(req.params.id, { scanAfter });
    audit.emit(req, { organizationId: inbox.organization_id, inboxId: inbox.id, action: 'scan_started', payload: { windowDays: days } });
    // Best-effort immediate kick (the lease prevents double-run with the drain
    // tick); only when this process is the configured scan runner.
    if (process.env.SUPPORT_SCAN_IN_API !== 'false') { scanOneDue().catch((e) => bestEffort('routes/supportInbox:anon#4', e)); }
    res.json({ inbox: updated });
});

router.get('/inboxes/:id/scan', async (req, res) => {
    const inbox = await loadInboxInScope(req, res, req.params.id);
    if (!inbox) return;
    res.json({ scan_status: inbox.scan_status, scan_progress: inbox.scan_progress, scan_result: inbox.scan_result });
});

// ── OAuth connect (dedicated per-mailbox flow — NOT the login OAuth) ──────────

router.get('/inboxes/:id/oauth/start', OAuth.oauthStart);
router.get('/oauth/callback', OAuth.oauthCallback);

// ── Threads (tenant-scoped) ───────────────────────────────────────────────────

router.get('/threads', validate({ query: S.ThreadsQuery }), Threads.listThreads);
router.get('/threads/:id', Threads.getThread);
router.get('/threads/:id/context', Threads.threadContext);
router.get('/threads/:id/events', Threads.threadEvents);
router.post('/threads/:id/reply', validate({ body: S.ReplyBody }), Threads.replyToThread);
router.post('/threads/:id/draft', Threads.draftReply);
router.patch('/threads/:id', validate({ body: S.PatchThreadBody }), Threads.patchThread);

// ── Settings reads, the live feed, access and audit ───────────────────────────

router.get('/canned', Settings.listCanned);
router.get('/tags', Settings.listTags);
router.get('/insights', validate({ query: S.InboxQuery }), Settings.insights);
router.get('/teammates', Settings.teammates);
router.get('/inboxes/:id/available-integrations', validate({ query: S.OperatorQuery }), Settings.availableIntegrations);
router.get('/stream', Settings.stream);
router.get('/inboxes/:id/settings', Settings.inboxSettings);
router.get('/inboxes/:id/access', Settings.getAccess);
router.put('/inboxes/:id/access', validate({ body: S.AccessBody }), Settings.putAccess);
router.get('/inboxes/:id/audit', validate({ query: S.InboxAuditQuery }), Settings.inboxAudit);
router.get('/audit', validate({ query: S.AuditQuery }), Settings.orgAudit);

// ── Org-scoped Templates & SLA writes (tenant-owned) ──────────────────────────

router.post('/tags', validate({ body: S.TagBody }), Writes.createTag);
router.delete('/tags/:id', Writes.deleteTag);
router.post('/canned', validate({ body: S.CreateCanned }), Writes.createCanned);
router.put('/canned/:id', validate({ body: S.UpdateCanned }), Writes.updateCanned);
router.delete('/canned/:id', Writes.deleteCanned);
router.get('/sla-policies', Writes.listSlaPolicies);
router.put('/sla-policies', validate({ body: S.SlaBody }), Writes.putSlaPolicy);

module.exports = router;
