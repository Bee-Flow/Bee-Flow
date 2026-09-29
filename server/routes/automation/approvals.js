/**
 * The Approvals section's API — list, facets, detail, decide, attachment.
 *
 * Visibility model (three tiers, resolved from the SESSION, never the query
 * string — the usageMonitoringAuth rule):
 *
 *   mine (default, every member)  owner ∨ assignee ∨ member of the assigned
 *                                 group. This is "waiting on me" plus "my
 *                                 routines' approvals".
 *   org (org admins only)         every approval stamped with the caller's
 *                                 own organisation. Requesting it without the
 *                                 role is a 403, not a silent narrowing —
 *                                 an admin whose toggle stopped working
 *                                 should hear about it, not see less data.
 *
 * Decision auth is approvalService.canDecide (owner / assignee / group member
 * / org admin) — deliberately shared with the legacy approve-step wrapper's
 * documentation so the two descriptions cannot drift.
 *
 * Mounted BEFORE ./crud in routes/automation.js: crud has GET /:id, which
 * would otherwise swallow the /approvals literal (the same first-match rule
 * that keeps /templates above /:id in runs.js).
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();
const automationStore = require('../../stores/automationStore');
const approvalService = require('../../automation/approvalService');
const { isOrgAdminRole } = require('../../auth/permissions');
const { requireCapability } = require('../../core/entitlements/entitlements');
const { requireModule } = require('../../modules');
const { validate } = require('../../core/http/validate');
const { contentDisposition } = require('../../core/http/contentDisposition');
const { z } = require('zod');

// -- What a caller may send ------------------------------------------
//
// The header above says an org admin whose toggle stopped working should
// HEAR about it rather than quietly see less. `scope` did not keep that
// promise: it was read as `=== 'org' ? 'org' : 'mine'`, so `scope=Org` --
// or any other spelling -- narrowed the list to the caller's own approvals
// and answered 200 with `scope: 'mine'`.
//
// `status` had the mirror-image failure. The store drops the values it does
// not recognise (`APPROVAL_STATUSES.includes`), and when that leaves the list
// empty there is no status condition left at all -- so `?status=aproved`
// answered with EVERY approval the viewer may see, presented as the approved
// ones somebody had filtered for.

/** A string whose every refusal -- including "you left it out" -- is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

/** A body that also accepts no body at all: Express 5 leaves `req.body` undefined then. */
const bodyOf = (shape) => z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object(shape).strict());

const one = (name, what) => worded(`${name} is ${what}.`).trim().min(1, `${name} is ${what}.`).optional();

// The store's own vocabulary (stores/automationStore/approvals.js). Copied
// deliberately: a store may not reach up into the HTTP layer, and a value
// added there without a thought for the API is the drift a test should catch.
const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'expired', 'cancelled'];
const STATUS_TEXT = `status is a comma-separated list of: ${APPROVAL_STATUSES.join(', ')}.`;
const SCOPE_TEXT = 'scope is "mine" or "org".';
const DECISION_TEXT = 'decision is "approve" or "reject".';

const scope = () => z.enum(['mine', 'org'], { errorMap: () => ({ message: SCOPE_TEXT }) }).default('mine');

const ApprovalsQuery = z.object({
    scope: scope(),
    status: worded(STATUS_TEXT).trim()
        .transform((v) => v.split(',').map((x) => x.trim()).filter(Boolean))
        .refine((list) => list.length > 0 && list.every((x) => APPROVAL_STATUSES.includes(x)), STATUS_TEXT)
        .optional(),
    cursor: one('cursor', 'the value a previous page returned as nextCursor'),
    limit: z.coerce.number({ invalid_type_error: 'limit must be a number.' })
        .int('limit must be a whole number.').optional(),
    appId: one('appId', 'the id of an app'),
    automationId: one('automationId', 'the id of a routine'),
    q: one('q', 'a search term'),
}).strict();

const FacetsQuery = z.object({ scope: scope(), appId: one('appId', 'the id of an app') }).strict();

const DecideBody = bodyOf({
    // Case has always been forgiving here, and the panel sends lower case;
    // what was NOT forgiving is the word itself, which approvalService
    // answered with a 400 after the row had already been read.
    decision: z.preprocess(
        (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v),
        z.enum(['approve', 'reject'], { errorMap: () => ({ message: DECISION_TEXT }) }),
    ),
    reason: worded('reason must be text.').nullish(),
    // The answers to THIS approval's questions. Their shape is the approval's
    // own `fields`, and approvalService.coerceSubmission measures them against
    // it -- so the schema asks only that it be a map, not a list or a word.
    answers: z.record(z.unknown()).nullish(),
});

const WithdrawBody = bodyOf({ reason: worded('reason must be text.').nullish() });

/**
 * Licence gate — Approvals is Enterprise (`approvals`, license/tiers.js).
 *
 * Attached PER ROUTE, never as a `router.use`: this router shares the
 * Community `/api/automation` mount, and Express is first-match, so the
 * /approvals literals must keep their exact position above crud's GET /:id
 * (pinned by routes/automation.routetable.test.js). A mid-file router.use
 * would sit either above the literals (gating half the automation API) or
 * below them (gating nothing).
 *
 * WHAT IS GATED: browsing. The list, the facets and the approver directory —
 * the surfaces that only make sense while you are building new approval flows.
 *
 * WHAT IS NOT (the drain exemption, deliberate): reading ONE approval,
 * deciding it, withdrawing it, and fetching an attachment it already carries.
 * An approval blocks a paused run; letting the licence lapse or a plan
 * downgrade freeze a pending decision would strand that run forever, with no
 * in-product way out. So in-flight work can always be finished — you just
 * cannot keep browsing without the licence. The legacy
 * POST /runs/:runId/approve-step (webhooksAndRunOps.js) is a decide path and
 * stays ungated for the same reason.
 *
 * The other half of the boundary — refusing to MINT a new approval without the
 * licence — belongs with the code that creates them (automation/
 * approvalService.js, appStudio/actionExecutor.js), not here: this router has
 * no create route.
 */
const gate = [requireModule('approvals'), requireCapability('approvals')];

/*
 * WHY THE MODULE GATE SITS ON THE SAME THREE ROUTES AND NOT ON THE ROUTER.
 *
 * Approvals is a platform module (modules/catalog.js), and an unimported
 * module is supposed to behave as if it isn't on the instance. Its capability
 * id does get dropped from the registry projection, but that alone answers
 * with 403 feature_locked — "this exists, you cannot have it" — where the
 * module contract calls for 404.
 *
 * A `router.use` would fix the status code and break the drain exemption
 * above: de-importing the module with approvals already pending would strand
 * every paused run behind a decision nobody can reach. So the module gate
 * takes exactly the boundary the licence gate already draws — browsing stops,
 * in-flight work still finishes — and rides along in the same `gate` chain so
 * the two cannot drift apart. (Chain, not a wrapper: Express flattens an
 * array of handlers, and routes/automation.routetable.test.js pins these
 * literals' position above crud's GET /:id.)
 *
 * In a genuine core-only build this is moot — `automation` is off too, so the
 * whole /api/automation mount 404s first. It matters for the runtime toggle.
 */

function getUserId(req) { return req.session?.user?.id || null; }

/**
 * Everything the scope decisions need about the caller, in one lookup:
 * their group ids (users.groups is a JSON TEXT column — parsed here), their
 * primary org, and whether they hold an org-admin role. Super admins fall
 * back to their own org for the org scope (the support-inbox precedent:
 * platform staff see their own tenant, not every tenant at once).
 */
async function resolveApprovalViewer(req) {
    const userId = getUserId(req);
    const userStore = require('../../stores/userStore');
    const user = await userStore.getUser(userId).catch(() => null);
    const { parseGroupIds } = require('../../auth/orgMembership');
    const groupIds = user ? parseGroupIds(user).map(String) : [];
    const orgId = user?.organizationId || null;
    const isOrgAdmin = !!(user && (isOrgAdminRole(user.orgRole) || req.session?.user?.isAdmin));
    return {
        userId,
        groupIds,
        orgId,
        isOrgAdmin,
        isOrgAdminOfOrg: (targetOrgId) => !!(isOrgAdmin && orgId && String(targetOrgId) === String(orgId)),
    };
}

/**
 * Lazy backfill for the caller's OWN legacy paused runs, so an approval that
 * predates the table still shows up in "waiting". Bounded and best-effort:
 * the list must render even when the backfill probe fails.
 */
async function backfillOwnPending(userId) {
    try {
        const { runs } = await automationStore.listRunsForUser(userId, { status: ['awaiting_approval'], limit: 25 });
        for (const run of runs) {
            const leg = run.journeyRunId && run.journeyRunId !== run.id
                ? await automationStore.getRun(run.journeyRunId).catch(() => null)
                : run;
            if (!leg || leg.status !== 'awaiting_approval' || !leg.awaitingStepId) continue;
            const existing = await automationStore.getApprovalForRunStep(leg.id, leg.awaitingStepId, { pendingOnly: true });
            if (existing) continue;
            const automation = await automationStore.getAutomation(leg.automationId).catch(() => null);
            await approvalService.ensureApprovalForRun(leg, automation);
        }
    } catch (e) {
        log.warn(`[automation/approvals] backfill probe failed for ${userId}: ${e.message}`);
    }
}

router.get('/approvals', gate, validate({ query: ApprovalsQuery }), async (req, res) => {
    const viewer = await resolveApprovalViewer(req);
    if (!viewer.userId) return res.status(401).json({ error: 'Not signed in' });
    const scope = req.query.scope;
    if (scope === 'org') {
        if (!viewer.isOrgAdmin || !viewer.orgId) {
            return res.status(403).json({ error: 'Organisation scope requires an organisation admin role.' });
        }
    } else {
        await backfillOwnPending(viewer.userId);
    }
    const { approvals, nextCursor } = await automationStore.listApprovals({
        ...(scope === 'org'
            ? { org: { orgId: viewer.orgId } }
            : { viewer: { userId: viewer.userId, groupIds: viewer.groupIds } }),
        status: req.query.status || [],
        cursor: req.query.cursor || null,
        limit: req.query.limit,
        // Narrowing filters only — the WHERE builder intersects them with
        // the proven scope, so they can never widen what the viewer sees.
        appId: req.query.appId || null,
        automationId: req.query.automationId || null,
        q: req.query.q || null,
    });
    res.json({ approvals, nextCursor, scope });
});

router.get('/approvals/facets', gate, validate({ query: FacetsQuery }), async (req, res) => {
    const viewer = await resolveApprovalViewer(req);
    if (!viewer.userId) return res.status(401).json({ error: 'Not signed in' });
    const scope = req.query.scope;
    if (scope === 'org' && (!viewer.isOrgAdmin || !viewer.orgId)) {
        return res.status(403).json({ error: 'Organisation scope requires an organisation admin role.' });
    }
    const facets = await automationStore.getApprovalFacets({
        ...(scope === 'org'
            ? { org: { orgId: viewer.orgId } }
            : { viewer: { userId: viewer.userId, groupIds: viewer.groupIds } }),
        appId: req.query.appId || null,
    });
    res.json({ facets, scope });
});

/**
 * Who can an approval be assigned to: the caller's org colleagues and org
 * groups, minimal fields only (the App Studio directory precedent —
 * getOrgMembersForDirectory is deliberately id/name/avatar and nothing else).
 * Member-readable: picking an approver is an authoring act, not an admin one.
 */
router.get('/approvals/directory', gate, async (req, res) => {
    const viewer = await resolveApprovalViewer(req);
    if (!viewer.userId) return res.status(401).json({ error: 'Not signed in' });
    if (!viewer.orgId) return res.json({ members: [], groups: [] });
    const userStore = require('../../stores/userStore');
    const members = (await userStore.getOrgMembersForDirectory(viewer.orgId).catch(() => []))
        .map(u => ({ id: u.id, name: u.displayName || u.username || u.id }));
    const groups = (await userStore.getAllGroups().catch(() => []))
        .filter(g => String(g.organizationId || '') === String(viewer.orgId))
        .map(g => ({ id: String(g.id), name: g.name || String(g.id) }));
    res.json({ members, groups });
});

router.get('/approvals/:id', async (req, res) => {
    const viewer = await resolveApprovalViewer(req);
    if (!viewer.userId) return res.status(401).json({ error: 'Not signed in' });
    const approval = await automationStore.getApproval(req.params.id);
    // Uniform 404 for missing AND unauthorized: an approval id must not be
    // an oracle for "does this exist in someone else's org".
    if (!approval || !approvalService.canView(approval, viewer)) {
        return res.status(404).json({ error: 'Approval not found' });
    }
    const audit = await automationStore.getApprovalAudit(approval.id).catch(() => []);
    // The run deep-link is an owner-only affordance — runs are owner-scoped
    // surfaces, so handing the link to an assignee would 403 them one
    // click later.
    const runLink = (approval.ownerId === viewer.userId && approval.automationId && approval.runId)
        ? require('../../utils/appPaths').automationRunStepPath(approval.automationId, approval.runId, approval.stepId)
        : null;
    // Panel rows: the votes so far, the rule's progress, and whether THIS
    // viewer still owes a vote — "can decide" means "can act right now",
    // not merely "holds a seat".
    let votes = null;
    let progress = null;
    let canDecideNow = approval.status === 'pending' && approvalService.canDecide(approval, viewer);
    if (approvalService.hasStages(approval) || approvalService.hasPanel(approval)) {
        const voteRows = await automationStore.getApprovalVotes(approval.id).catch(() => []);
        votes = voteRows.map(approvalService.voteSummary);
        progress = approvalService.panelProgress(approval, voteRows);
        // "Can decide" means "can act RIGHT NOW": holding a seat in the
        // current stage is not enough if this person already used it.
        if (canDecideNow) {
            if (approvalService.hasStages(approval)) {
                const stage = approvalService.currentStage(approval);
                canDecideNow = !!stage && approvalService.seatIndexFor(
                    stage.approvers || [], voteRows.filter(v => v.stage === stage.key), viewer) >= 0;
            } else {
                const stage = approval.stage || 'panel';
                canDecideNow = stage === 'final'
                    ? !voteRows.some(v => v.stage === 'final' && v.voterId === viewer.userId)
                    : approvalService.seatIndexFor(approval.approvers, voteRows.filter(v => v.stage === 'panel'), viewer) >= 0;
            }
        }
    }
    res.json({
        approval,
        audit,
        runLink,
        ...(votes ? { votes, progress } : {}),
        canDecide: canDecideNow,
        canWithdraw: approval.status === 'pending'
            && (approval.ownerId === viewer.userId
                || (approval.organizationId && viewer.isOrgAdminOfOrg(approval.organizationId))),
    });
});

router.post('/approvals/:id/decide', validate({ body: DecideBody }), async (req, res) => {
    const viewer = await resolveApprovalViewer(req);
    if (!viewer.userId) return res.status(401).json({ error: 'Not signed in' });
    const approval = await automationStore.getApproval(req.params.id);
    if (!approval || !approvalService.canView(approval, viewer)) {
        return res.status(404).json({ error: 'Approval not found' });
    }
    if (!approvalService.canDecide(approval, viewer)) {
        return res.status(403).json({ error: 'You cannot decide this approval.' });
    }
    const run = approval.runId ? await automationStore.getRun(approval.runId).catch(() => null) : null;
    const { code, body } = await approvalService.decide({
        approval,
        run,
        deciderId: viewer.userId,
        decision: req.body.decision,
        reason: req.body.reason,
        answers: req.body.answers,
        source: 'studio',
    });
    res.status(code).json(body);
});

/**
 * Withdraw — the requester's "never mind". Deliberately NARROWER than decide:
 * the owner (whose routine/app asked) or an org admin. An assignee who wants
 * out declines with a reason; letting them silently retract someone else's
 * question would erase the ask from under the owner.
 */
router.post('/approvals/:id/withdraw', validate({ body: WithdrawBody }), async (req, res) => {
    const viewer = await resolveApprovalViewer(req);
    if (!viewer.userId) return res.status(401).json({ error: 'Not signed in' });
    const approval = await automationStore.getApproval(req.params.id);
    if (!approval || !approvalService.canView(approval, viewer)) {
        return res.status(404).json({ error: 'Approval not found' });
    }
    const mayWithdraw = approval.ownerId === viewer.userId
        || (approval.organizationId && viewer.isOrgAdminOfOrg(approval.organizationId));
    if (!mayWithdraw) return res.status(403).json({ error: 'Only the owner or an org admin can withdraw this approval.' });
    const { code, body } = await approvalService.withdraw({
        approval,
        deciderId: viewer.userId,
        reason: req.body.reason,
        source: 'studio',
    });
    res.status(code).json(body);
});

/**
 * "Send reminder" (handoff 5, Runs tab): nudge whoever this pending approval
 * still waits on, through the same path as the scheduled reminder. At most
 * once per approval per 10 minutes. Who may press it and why:
 * automation/approvalRemind.js. Ungated like decide: it moves in-flight work
 * along, it does not browse.
 *
 * 200 { reminded: true, remindedAt, nextAllowedAt, recipients }
 * 404 approval_not_found, 403 approval_remind_forbidden,
 * 409 approval_not_pending, 429 remind_rate_limited (details.retryAfterSec).
 */
const remindLimiter = require('../../utils/perUserRateLimit').perUserRateLimit({ windowMs: 60_000, max: 20 });
router.post('/approvals/:id/remind', remindLimiter, async (req, res) => {
    const { makeApprovalReminder } = require('../../automation/approvalRemind');
    const { makeAutomationAccess } = require('../../automation/access');
    const reminder = makeApprovalReminder({
        store: automationStore,
        canView: (approval, viewer) => approvalService.canView(approval, viewer),
        roleFor: makeAutomationAccess({ store: automationStore }).roleFor,
        sendReminder: (approval) => require('../../core/automationRunner/approvalLifecycle').sendApprovalReminder(approval),
    });
    try {
        const body = await reminder.remind({
            approvalId: req.params.id,
            viewer: await resolveApprovalViewer(req),
            session: req.session || null,
        });
        res.json(body);
    } catch (e) {
        if (e && e.status === 429 && e.details?.retryAfterSec) res.set('Retry-After', String(e.details.retryAfterSec));
        throw e;
    }
});

router.get('/approvals/:id/files/:fileId', async (req, res) => {
    const viewer = await resolveApprovalViewer(req);
    if (!viewer.userId) return res.status(401).json({ error: 'Not signed in' });
    const approval = await automationStore.getApproval(req.params.id);
    if (!approval || !approvalService.canView(approval, viewer)) {
        return res.status(404).json({ error: 'Not found' });
    }
    // Two locks, both required: the file must be in THIS approval's
    // snapshot (viewing one approval is not a licence to fish the run's
    // other files), and it must still resolve through the run-scoped
    // ledger read — an id alone is never a capability.
    const snap = (approval.attachments || []).find(a => a.fileId === req.params.fileId);
    if (!snap) return res.status(404).json({ error: 'Not found' });
    // App-sourced attachments live in the app's own owner-scoped ledger,
    // not the run-files table. The approval snapshot IS the capability
    // here: canView on the approval + the fileId in its snapshot — an
    // approver need not be (and often is not) a member of the app.
    if (snap.store === 'app') {
        if (!approval.studioAppId) return res.status(404).json({ error: 'Not found' });
        const studioAppDataStore = require('../../stores/studioAppDataStore');
        const att = await studioAppDataStore
            .getAttachment(req.params.fileId, approval.studioAppId, approval.ownerId)
            .catch(() => null);
        if (!att || att.quarantined) return res.status(404).json({ error: 'Not found' });
        const storageStore = require('../../stores/storageStore');
        let streamed;
        try {
            streamed = await storageStore.streamFile(
                storageStore.buildStudioAppAttachmentKey(approval.ownerId, approval.studioAppId, att.sha256));
        } catch (e) {
            log.warn(`[automation/approvals] app attachment ${att.id} has no bytes: ${e.message}`);
            return res.status(404).json({ error: 'Not found' });
        }
        res.setHeader('Content-Type', snap.mimeType || att.mimeType || 'application/octet-stream');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Disposition', contentDisposition(snap.filename));
        if (streamed.contentLength != null) res.setHeader('Content-Length', streamed.contentLength);
        streamed.stream.on('error', (e) => {
            log.error(`[automation/approvals] app download stream failed: ${e.message}`);
            if (!res.headersSent) res.status(500).end();
            else res.destroy();
        });
        return streamed.stream.pipe(res);
    }
    const chainRoot = approval.rootRunId || approval.runId;
    if (!chainRoot) return res.status(404).json({ error: 'Not found' });
    const chain = await automationStore.getRunsInChain(chainRoot).catch(() => []);
    const runIds = chain.map(r => r.id);
    if (approval.runId && !runIds.includes(approval.runId)) runIds.push(approval.runId);
    const file = await automationStore.getGeneratedFileForRuns(req.params.fileId, runIds);
    if (!file) return res.status(404).json({ error: 'Not found' });

    const storageStore = require('../../stores/storageStore');
    let streamed;
    try {
        streamed = await storageStore.streamFile(file.storageKey);
    } catch (e) {
        // The reaper deletes blobs before rows — a live row with no bytes
        // is a normal race, not a server fault.
        log.warn(`[automation/approvals] file ${file.id} has no bytes: ${e.message}`);
        return res.status(404).json({ error: 'Not found' });
    }
    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    // nosniff + attachment: author-influenced content must download, never
    // render in the app's origin (the formPublic download rule).
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', contentDisposition(file.filename));
    if (streamed.contentLength != null) res.setHeader('Content-Length', streamed.contentLength);
    streamed.stream.on('error', (e) => {
        log.error(`[automation/approvals] download stream failed: ${e.message}`);
        if (!res.headersSent) res.status(500).end();
        else res.destroy();
    });
    return streamed.stream.pipe(res);
});

module.exports = router;
