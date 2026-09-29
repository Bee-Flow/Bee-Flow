/**
 * approvalHooks — the on_decided record-write hook.
 *
 * An app-sourced approval carries a SNAPSHOTTED hook config: which app-table
 * row flips, and what each outcome writes. Executed here, synchronously in
 * whatever flipped the row to final (decide / withdraw / reaper expiry) —
 * NEVER before the decision commits, and a hook failure NEVER rolls the
 * decision back: at-least-once-decided, best-effort-hook. Failures are
 * appended to the approval's audit trail and belled to the owner, so a
 * renamed column is a visible bug, not a silently stale status.
 *
 * The write goes through actionExecutor.writeRecord acts-as-owner — the one
 * choke point every app write takes (RLS, quota, data-version bump), so the
 * app's viewers see the flip on their next refetch with zero push machinery.
 *
 * Templates: a `set` value that is exactly "{{path}}" resolves to the RAW
 * value at that path (booleans/numbers keep their type); any other string
 * interpolates each {{path}} as text. Paths read the decided row:
 *   decision reason prompt approvalId decidedBy decidedByName decidedAt
 *   requestedBy answers.<question> context.<key>
 * Non-string literals pass through unchanged.
 */

const automationStore = require('../stores/automationStore');
const log = require('../telemetry/log');

const TEMPLATE_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

function hookScope(approval) {
    return {
        decision: approval.status,
        reason: approval.decisionReason ?? null,
        prompt: approval.prompt ?? null,
        approvalId: approval.id,
        decidedBy: approval.decidedBy ?? null,
        decidedByName: approval.decidedByName ?? null,
        decidedAt: approval.decidedAt ?? null,
        requestedBy: approval.requestedBy ?? null,
        answers: approval.answers || {},
        context: approval.context || {},
    };
}

function lookupPath(scope, path) {
    let cur = scope;
    for (const part of String(path).split('.')) {
        if (cur == null || typeof cur !== 'object') return undefined;
        cur = cur[part];
    }
    return cur;
}

function resolveTemplate(value, scope) {
    if (typeof value !== 'string') return value;           // literal number/bool/null
    const exact = value.match(/^\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}$/);
    if (exact) {
        const v = lookupPath(scope, exact[1]);
        return v === undefined ? null : v;
    }
    return value.replace(TEMPLATE_RE, (_, p) => {
        const v = lookupPath(scope, p);
        return v === null || v === undefined ? '' : String(v);
    });
}

/**
 * Run the hook for a row that just reached a final status. Never throws.
 * Returns { ran, error? } for callers that surface it (tests, the decide
 * response's audit trail).
 */
async function runOnDecidedHook(approval) {
    const hook = approval?.onDecided;
    if (!hook || !approval.studioAppId || approval.status === 'pending') return { ran: false };
    const set = hook.set && typeof hook.set === 'object' ? hook.set[approval.status] : null;
    if (!set || typeof set !== 'object' || !Object.keys(set).length) return { ran: false };

    try {
        const studioAppStore = require('../stores/studioAppStore');
        const app = await studioAppStore.getStudioApp(approval.studioAppId);
        if (!app) throw new Error('the app no longer exists');
        const studioAppDataStore = require('../stores/studioAppDataStore');
        const meta = await studioAppDataStore.getDataModel(app.id, app.userId);
        const model = meta?.model || null;
        const actionExecutor = require('../appStudio/actionExecutor');
        const table = actionExecutor._findTable(model, hook.tableId);
        if (!table) throw new Error(`table "${hook.tableId}" no longer exists`);
        const recordId = typeof hook.recordId === 'string' && hook.recordId ? hook.recordId : null;
        if (!recordId) throw new Error('the hook has no record to update');

        const scope = hookScope(approval);
        const values = {};
        for (const [col, tmpl] of Object.entries(set)) values[col] = resolveTemplate(tmpl, scope);

        const res = await actionExecutor.writeRecord(app, model, table, values, {
            viewer: { id: app.userId, role: 'owner' },
            recordId,
        });
        if (!res || res.updated === false) throw new Error('the record no longer exists');

        await automationStore.appendApprovalAudit({
            approvalId: approval.id, decidedBy: null,
            decision: 'hook_ran',
            comment: `Updated ${table.key || hook.tableId} · ${recordId}`,
            source: 'hook',
        }).catch(() => {});
        return { ran: true };
    } catch (e) {
        log.warn(`[ApprovalHooks] on_decided failed for ${approval.id}: ${e.message}`);
        await automationStore.appendApprovalAudit({
            approvalId: approval.id, decidedBy: null,
            decision: 'hook_failed', comment: e.message, source: 'hook',
        }).catch(() => {});
        // The decision stands; the OWNER hears their app did not react.
        try {
            const notificationStore = require('../stores/notificationStore');
            await notificationStore.createNotification({
                userId: approval.ownerId,
                category: 'urgent',
                title: `⚠️ App update failed after a decision`,
                message: `The decision on "${approval.prompt || 'an approval'}" was recorded, but the app's record could not be updated: ${e.message}`,
                link: require('../utils/appPaths').approvalPath(approval.id),
            });
        } catch { /* the audit row still tells the story */ }
        return { ran: false, error: e.message };
    }
}

module.exports = { runOnDecidedHook, _hooksTest: { resolveTemplate, hookScope } };
