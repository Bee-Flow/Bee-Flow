/**
 * THE ACCESS PHASE — who may open the app the playbook built, and with which
 * role. No recipe asks for it and no model writes it: the assistant here
 * PROPOSES, the person approves, and the client applies the proposal through
 * the owner-only endpoints that already audit those writes.
 *
 * The digest the assistant reads lives here too, because this is the only
 * phase that asks what is actually IN the table in order to answer "a role
 * for each supplier".
 */

'use strict';

const lifecycle = require('../../playbooks/lifecycle');
const { sendErr, MAX_DESCRIPTION, worded, bodyOf, check } = require('./contract');

// One key is read here: the sentence about who should use the app. A
// misspelled one read as "no message", which this route refuses -- but it
// refused it as though the person had typed nothing, which is not what
// happened and not what they could act on.
const MESSAGE_TEXT = 'Say who should use this app.';
const AccessPlanBody = bodyOf({
    message: worded(MESSAGE_TEXT).trim().min(1, MESSAGE_TEXT).max(MAX_DESCRIPTION, `Keep it under ${MAX_DESCRIPTION} characters.`),
});
const { kindOf, firstOfKind, appBefore, localeOf } = require('./phaseList');
// WHO THE ASSISTANT MAY NAME — the organisation's directory, never the
// installation's (the rule and its history are in ./directory.js).
const { directoryFor } = require('./directory');
const log = require('../../telemetry/log');

// The data digest handed to the access assistant (playbooks/accessPlan.js caps
// the same numbers on its side).
const DIGEST_COLUMNS = 6;
const DIGEST_VALUES = 40;

/**
 * WHAT IS IN THE TABLE — the distinct values of its categorical columns.
 *
 * "A role for each supplier" is unanswerable without this, and reading the
 * whole table to find out would be both slow and a privacy problem of its own.
 * One grouped count per candidate column, through `datatableRuntime.aggregateRows`
 * so the reader's own access filter applies: a column with more distinct values
 * than a person could choose from is dropped rather than truncated, because a
 * truncated list invites the model to invent the rest.
 */
async function readDataDigest(d, playbook, tableArt) {
    const fields = Array.isArray(tableArt && tableArt.fields) ? tableArt.fields : [];
    const candidates = fields.filter((f) => f && ['text', 'select'].includes(f.type) && f.key).slice(0, DIGEST_COLUMNS);
    if (!tableArt || !tableArt.datatableId || !candidates.length) return null;
    let resolved;
    try {
        const principal = await d.datatableAccessPlan.resolveDatatablePrincipalForUser(playbook.userId);
        resolved = await d.datatableRuntime.resolveForPrincipal(tableArt.datatableId, principal, { needed: 'viewer' });
    } catch (e) {
        return null;   // no digest is a smaller problem than a failed phase
    }
    const allowColumns = fields.map((f) => f.key).filter(Boolean);
    const columns = [];
    for (const f of candidates) {
        try {
            const { rows } = await d.datatableRuntime.aggregateRows(resolved, {
                allowColumns,
                groupBy: [{ field: f.key }],
                aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                limit: DIGEST_VALUES + 1,
            });
            const values = rows
                .map((r) => ({ value: r[f.key], count: Number(r.n) }))
                .filter((v) => typeof v.value === 'string' && v.value.trim());
            if (!values.length || values.length > DIGEST_VALUES) continue;
            columns.push({ key: f.key, name: f.name || f.key, values });
        } catch { /* one unreadable column is not a reason to give up on the rest */ }
    }
    return columns.length ? { tableName: tableArt.datatableName || null, columns } : null;
}

function register(router, ctx) {
    const { d, flow, requireManageApps, runLimiter } = ctx;
    const { load, phaseTier } = flow;

    /**
     * The ACCESS phase's assistant: a sentence in, a PROPOSAL out. It reads
     * the app's roles and the workspace directory, resolves the names the
     * model used into real ids, and returns them. It writes nothing at all —
     * the person approves the proposal and the CLIENT applies it through the
     * owner-only endpoints that already audit every one of those writes.
     */
    router.post('/:id/phases/:key/access-plan', requireManageApps, runLimiter, async (req, res) => {
        try {
            const pb = await load(req, res);
            if (!pb) return;
            const cur = lifecycle.phaseByKey(pb.phases, req.params.key);
            if (!cur || kindOf(cur) !== 'access') return sendErr(res, 400, 'bad_patch', 'That is not an access phase.');
            const appId = (cur.artifacts && cur.artifacts.appId) || appBefore(pb.phases, cur.key);
            if (!appId) return sendErr(res, 409, 'artifacts_missing', 'This phase has no app to give access to.');
            const app = await d.studioAppStore.getStudioApp(appId);
            if (!app) return sendErr(res, 409, 'artifacts_missing', 'That app does not exist.');
            if (app.userId !== pb.userId) return sendErr(res, 403, 'not_owner', 'That app is not yours.');
            const parsed = check(res, AccessPlanBody, req.body, 'message_required');
            if (!parsed.ok) return;
            const message = parsed.value.message;
            // The assistant's tier: the playbook's, measured against the
            // owner's list now (phaseFlow.phaseTier).
            const tier = await phaseTier(req, res, pb);
            if (!tier) return;

            const meta = await d.studioAppDataStore.getDataModel(appId, app.userId).catch(() => null);
            const model = (meta && meta.model) || null;
            const roles = (model && Array.isArray(model.roles)) ? model.roles : [];
            const [groups, users] = await Promise.all([
                d.userStore.getAllGroups().catch(() => []),
                d.userStore.getAllUsers().catch(() => []),
            ]);

            // The table this app reads, as the model names it: a row rule is
            // stored per MODEL table, keyed by the app role, and only bites on
            // the table the app actually links (see appStudio/datatableSource).
            const tableArt = (firstOfKind(pb.phases, 'table') || {}).artifacts || {};
            const modelTable = (model && Array.isArray(model.tables) ? model.tables : [])
                .find((t) => t && t.source && t.source.kind === 'datatable' && t.source.datatableId === tableArt.datatableId) || null;
            const digest = modelTable ? await readDataDigest(d, pb, tableArt) : null;
            // Every rule the assistant proposes is compiled against the REAL
            // table before the person ever sees it. A rule that cannot compile
            // is reported as unresolved, never stored and never shown as done.
            const validateRule = modelTable
                ? (expr) => { try { return d.rlsGateway.validateRowFilter(expr, modelTable); } catch (e) { return { ok: false, errors: [e.message] }; } }
                : null;
            const directory = directoryFor(pb, req.session, groups || [], users || []);
            const out = await d.planAccess({
                tier,
                message,
                appName: app.name || pb.title || 'App',
                roles,
                digest,
                tableId: modelTable ? modelTable.id : null,
                validateRule,
                groups: directory.groups.map((g) => ({ id: g.id, name: g.name })),
                people: directory.users.map((u) => ({ id: u.id, name: u.name || u.fullName || '', email: u.email || '' })),
                locale: localeOf(pb) || 'en',
                userId: pb.userId,
                userOrgId: pb.organizationId,
            });
            // An unreachable model carries the id its log line was written under.
            if (!out.ok) return sendErr(res, 422, out.code, out.error, out.correlationId ? { correlationId: out.correlationId } : {});
            res.json({ plan: out.plan });
        } catch (e) {
            log.error('[Playbooks] access plan failed:', e.message);
            sendErr(res, 500, 'internal', 'Could not read that');
        }
    });
}

module.exports = { register };
