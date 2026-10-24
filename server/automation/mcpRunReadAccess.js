// @typecheck
'use strict';
/**
 * Who may read a run over MCP, and whether raw values may leave (mcpRunReads.js).
 *
 *   scope   the automation must be the token user's own, in that user's
 *           organisation; anything else answers 404, like a run that does not
 *           exist. On top comes the run-data read check every run read makes
 *           (core/automationModel/callerRunVisibility.js).
 *   policy  the organisation setting `rawReadsAllowed` (off by default) and the
 *           access-audit row every raw read writes first.
 *
 * Collaborators are injected so the tests hand in a store.
 */

const { HttpError } = require('../core/http/errors');
const log = require('../telemetry/log');
const { MAX_ID_CHARS } = require('./mcpRunReadCaps');
const { fallback } = require('../utils/bestEffort');

const RAW_READ_AUDIT_ACTION = 'mcp.automation_run_data.read';
const RAW_POLICY_AUDIT_ACTION = 'mcp.automation_run_data.policy';

// Stored per organisation under `org_<orgId>_automation_mcp_run_data` (the
// `org_<orgId>_%` sweep removes it with the organisation). Anything but an
// explicit `rawReadsAllowed: true` is "no", including an unreadable value.
const rawPolicyKey = (orgId) => `org_${orgId}_automation_mcp_run_data`;

const text = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * @param {{
 *   store?: any,
 *   getUser?: (id: string) => Promise<any>,
 *   getConfig?: (key: string) => Promise<any>,
 *   setConfig?: (key: string, value: any) => Promise<any>,
 *   audit?: (action: string, targetType: string, targetId: string, actorId: string|null, before: any, after: any, orgId: string|null) => Promise<any>,
 * }} [overrides]
 */
function makeAccess(overrides = {}) {
    const store = () => overrides.store || require('../stores/automationStore');
    const getUser = overrides.getUser || ((id) => require('../stores/userStore').getUser(id));
    const getConfig = overrides.getConfig || ((key) => require('../stores/configStore').getConfigFresh(key));
    const setConfig = overrides.setConfig || ((key, value) => require('../stores/configStore').setConfig(key, value));
    const audit = overrides.audit
        || ((...args) => require('../stores/userStore').logAccessAudit(...args));

    const notFound = (what) => new HttpError(404, 'not_found', `${what} not found, or this token's user does not have it. Call automations_list for the automations you own.`);

    /**
     * The automation, if it is the token user's own and in their organisation.
     * 404 either way: whether somebody else's automation exists is not told.
     */
    async function loadOwnedAutomation(automationId, userId, what = 'Automation') {
        const a = automationId ? await store().getAutomation(automationId).catch((e) => fallback('automation/mcpRunReadAccess:loadOwnedAutomation', e, null)) : null;
        if (!a || a.userId !== userId) throw notFound(what);
        const user = await getUser(userId).catch((e) => fallback('automation/mcpRunReadAccess:loadOwnedAutomation#2', e, null));
        const userOrg = user?.organizationId || null;
        // An automation of another organisation is not reachable, whoever the owner column names.
        if (!user || (a.organizationId && a.organizationId !== userOrg)) throw notFound(what);
        return { automation: a, orgId: a.organizationId || userOrg };
    }

    /** The run, its automation and the legs of its journey, or 404. */
    async function loadOwnedRun(runId, userId) {
        const id = text(runId);
        if (!id || id.length > MAX_ID_CHARS) throw new HttpError(400, 'invalid_run_id', 'runId is required (an id from automations_list_runs).');
        const run = await store().getRun(id).catch((e) => fallback('automation/mcpRunReadAccess:loadOwnedRun', e, null));
        if (!run) throw notFound('Run');
        const { automation, orgId } = await loadOwnedAutomation(run.automationId, userId, 'Run');
        const legs = await store().getRunsInChain(run.id).catch((e) => fallback('automation/mcpRunReadAccess:loadOwnedRun#2', e, []));
        return { run, automation, orgId, legs: Array.isArray(legs) && legs.length ? legs : [run] };
    }

    /** May this organisation read raw run values over MCP? Unreadable or absent = no. */
    async function rawReadsAllowed(orgId) {
        if (!orgId) return false;
        try {
            const v = await getConfig(rawPolicyKey(orgId));
            const doc = typeof v === 'string' ? JSON.parse(v) : v;
            return !!doc && doc.rawReadsAllowed === true;
        } catch (e) {
            log.warn(`[automations-mcp] raw run data setting for org ${orgId} unreadable: ${e.message}`);
            return false;
        }
    }

    /** Switch raw run reads over MCP on or off for an organisation (audited). */
    async function setRawReadsAllowed(orgId, allowed, actorId) {
        if (!orgId) throw new HttpError(400, 'no_organization', 'This account has no organisation to set this for.');
        const before = await rawReadsAllowed(orgId);
        await setConfig(rawPolicyKey(orgId), { rawReadsAllowed: allowed === true });
        await audit(RAW_POLICY_AUDIT_ACTION, 'organization', orgId, actorId || null, { rawReadsAllowed: before }, { rawReadsAllowed: allowed === true }, orgId);
        return { rawReadsAllowed: allowed === true };
    }

    /** Refuse a raw read the organisation has not allowed. Called before any value is read. */
    async function requireRawAllowed(orgId) {
        if (!await rawReadsAllowed(orgId)) {
            throw new HttpError(403, 'raw_run_data_disabled',
                'Raw run data over MCP is switched off for this organisation. Read the protected form instead (omit raw), or ask an organisation admin to allow raw run data for MCP.');
        }
    }

    /**
     * The ledger row of a raw read, written before the values are returned: no
     * row, no data. What is recorded is what was asked for, never the values.
     */
    async function auditRawRead(orgId, userId, targetType, targetId, details) {
        try {
            await audit(RAW_READ_AUDIT_ACTION, targetType, targetId, userId, null, { ...details, via: 'mcp' }, orgId);
        } catch (e) {
            log.error(`[automations-mcp] audit row for a raw run read could not be written: ${e.message}`);
            throw new HttpError(503, 'audit_unavailable', 'The audit log is not available, so raw run data is not returned.');
        }
    }

    /** Find one step row: the given attempt, else the last one. */
    async function findStep(run, legs, stepId, attempts, userId) {
        const { canReadRunData } = require('../core/automationModel/callerRunVisibility');
        const rows = (await store().getRunStepsForChain(run.id)).filter((s) => s.stepId === stepId);
        const row = attempts
            ? rows.find((s) => s.attempts === attempts)
            : rows.slice().sort((a, b) => (a.attempts || 0) - (b.attempts || 0)).pop();
        if (!row) throw new HttpError(404, 'step_not_found', `Run ${run.id} has no step "${stepId.slice(0, 80)}"${attempts ? ` at attempt ${attempts}` : ''}. Call automations_get_run_steps for its step ids.`);
        const leg = legs.find((l) => l.id === row.runId) || (row.runId === run.id ? run : null);
        // A leg that cannot be identified is not readable: a failed lookup never opens a door.
        if (!leg || !canReadRunData(leg, userId)) {
            throw new HttpError(403, 'caller_run_private', 'This run used the connections of the person who started it, so only they can see its data.');
        }
        return row;
    }

    return { store, loadOwnedAutomation, loadOwnedRun, findStep, rawReadsAllowed, setRawReadsAllowed, requireRawAllowed, auditRawRead };
}

module.exports = { makeAccess, rawPolicyKey, text, RAW_READ_AUDIT_ACTION };
