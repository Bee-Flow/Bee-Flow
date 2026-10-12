/**
 * Is this stage ready to run this release (design 6.3 `readiness`, 3.3, 3.4,
 * 4.1, 4.2, 6.6)? Findings in the core/findings shape, each with the slot,
 * ref or variable name it is about. `error` blocks the deploy; `warning`
 * informs.
 *
 *   binding.missing         a slot of the release has no binding ("use the same
 *                           as Dev" is one click and never implicit)
 *   binding.hosts_missing   a PRD connection binding without allowed hosts (D18)
 *   variable.missing        a required variable without a value
 *   variable.invalid        a value that does not fit its declared type
 *   connection.unusable     the run-as user may not use a bound connection
 *                           (authorizeConnectionUse, the runtime's own check)
 *   integration.missing     an automation's integration step needs a provider the
 *                           run-as user has no usable connection for (an error
 *                           in PRD, a warning in UAT, where testers may skip it)
 *   address.taken           a bound page slug belongs to another page
 *   approval_policy.stale   PRD with the gate on: the policy no longer validates,
 *                           or a stage lost its last approver who is not the owner
 */

'use strict';

const { makeFinding } = require('../../core/findings/finding');

const walkAllSteps = (definition, fn) => require('../../automation/portability').walkAllSteps(definition, fn);
const dep = (deps, name, load) => (deps && deps[name] !== undefined ? deps[name] : load());
const rowsOf = (res) => (Array.isArray(res) ? res : (res && res.rows) || []);
function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function finding(stage, { code, severity = 'error', message, remediation, ...extra }) {
    return {
        ...makeFinding({
            code, severity, kind: 'solution',
            targetRef: { kind: 'solution', id: stage.projectId || null },
            message, ...(remediation ? { remediation } : {}),
        }),
        ...extra,
    };
}

const isEmptyValue = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

function slotFindings(stage, slots, bindings) {
    const out = [];
    const seen = new Set();
    for (const s of Array.isArray(slots) ? slots : []) {
        if (!s || typeof s.slot !== 'string' || seen.has(s.slot)) continue;
        seen.add(s.slot);
        const value = bindings.get(s.slot);
        if (value === undefined || value === null) {
            out.push(finding(stage, {
                code: 'binding.missing', slot: s.slot, ref: s.ref || null,
                message: `"${s.label || s.slot}" has no setting in this stage.`,
                remediation: 'Open the stage settings and choose one, or use the same as Dev.',
            }));
            continue;
        }
        if (s.kind === 'connection' && stage.stage === 'prd'
            && !(isObject(value) && Array.isArray(value.allowedHosts) && value.allowedHosts.length)) {
            out.push(finding(stage, {
                code: 'binding.hosts_missing', slot: s.slot, ref: s.ref || null,
                message: `The connection for "${s.label || s.slot}" does not say which hosts it may be sent to.`,
                remediation: 'Add the allowed hosts to the connection setting.',
            }));
        }
    }
    return out;
}

function variableFindings(stage, declarations, values) {
    const { coerceValue } = require('../../stores/solutionStage/variables');
    const byName = new Map((Array.isArray(values) ? values : []).filter(v => v && v.name).map(v => [v.name, v]));
    const out = [];
    for (const d of Array.isArray(declarations) ? declarations : []) {
        if (!d || typeof d.name !== 'string') continue;
        const row = byName.get(d.name);
        const value = row ? row.value : undefined;
        if (isEmptyValue(value)) {
            if (d.required !== false) {
                out.push(finding(stage, { code: 'variable.missing', name: d.name, message: `The variable "${d.name}" has no value in this stage.` }));
            }
            continue;
        }
        if (coerceValue(d.type || 'text', value, d.choices) === undefined) {
            out.push(finding(stage, { code: 'variable.invalid', name: d.name, message: `The value of "${d.name}" is not a valid ${d.type || 'text'}.` }));
        }
    }
    return out;
}

async function connectionFindings(stage, bindingRows, deps) {
    const out = [];
    const rows = (Array.isArray(bindingRows) ? bindingRows : []).filter(b => b && b.kind === 'connection' && isObject(b.value));
    if (!rows.length) return out;
    const authorize = dep(deps, 'authorizeConnectionUse', () => require('../../stores/integrationConnectionStore').authorizeConnectionUse);
    const groupsOf = dep(deps, 'groupsOf', () => async (userId) => {
        const user = await require('../../stores/userStore').getUser(userId);
        return user ? require('../../auth/orgMembership').parseGroupIds(user).map(String) : [];
    });
    const groups = await groupsOf(stage.runAsUserId);
    for (const b of rows) {
        const verdict = await authorize({
            connectionId: b.value.connectionId, runningUserId: stage.runAsUserId,
            runningUserOrgId: stage.organizationId || null, runningUserGroups: groups,
        });
        if (verdict && verdict.ok) continue;
        out.push(finding(stage, {
            code: 'connection.unusable', slot: b.slot, reason: (verdict && verdict.reason) || null,
            message: 'The run-as user may not use the connection chosen for this stage.',
            remediation: 'Choose a connection of the run-as user, or one lent to them.',
        }));
    }
    return out;
}

/** The providers the release's automations draw credentials from (integration_action steps). */
function requiredProviders(manifest, providerForTool) {
    const providers = new Map();
    for (const a of Array.isArray(manifest?.solution?.entities?.automations) ? manifest.solution.entities.automations : []) {
        walkAllSteps(a.definition, (step, layerKey, isTrigger) => {
            if (isTrigger || !isObject(step) || step.type !== 'integration_action' || typeof step.tool !== 'string') return;
            const provider = providerForTool(step.tool);
            if (provider && !providers.has(provider)) providers.set(provider, a.ref || null);
        });
    }
    return providers;
}

async function integrationFindings(stage, manifest, deps) {
    const providerForTool = dep(deps, 'providerForTool', () => require('../../core/integrations/connectionResolution').providerForTool);
    const providers = requiredProviders(manifest, providerForTool);
    if (!providers.size) return [];
    const available = dep(deps, 'providerAvailable', () => async (provider, who) => {
        const r = await require('../../stores/integrationConnectionStore').resolveConnectionForRun({
            runningUserId: who.runAsUserId, runningUserOrgId: who.organizationId, provider,
        });
        return !!(r && r.available);
    });
    const out = [];
    for (const [provider, ref] of providers) {
        if (await available(provider, { runAsUserId: stage.runAsUserId, organizationId: stage.organizationId || null })) continue;
        out.push(finding(stage, {
            code: 'integration.missing', severity: stage.stage === 'prd' ? 'error' : 'warning', provider, ref,
            message: `The run-as user has no ${provider} connection, which an automation of this release needs.`,
            remediation: 'Connect the app with the account of the run-as user.',
        }));
    }
    return out;
}

async function addressFindings(stage, bindingRows, stamps, deps) {
    const slugs = (Array.isArray(bindingRows) ? bindingRows : [])
        .filter(b => b && typeof b.slot === 'string' && b.slot.startsWith('slug:') && isObject(b.value) && b.value.slug);
    if (!slugs.length) return [];
    const ownerOfSlug = dep(deps, 'slugOwner', () => async (slug) => {
        const db = require('../../db');
        return rowsOf(await db.run('SELECT id FROM webpages WHERE slug = $1', [slug]))[0]?.id || null;
    });
    const out = [];
    for (const b of slugs) {
        const ref = b.slot.slice('slug:'.length);
        const own = stamps && stamps.get ? stamps.get(ref)?.entityId : null;
        const owner = await ownerOfSlug(String(b.value.slug).toLowerCase());
        if (owner && owner !== own) {
            out.push(finding(stage, { code: 'address.taken', slot: b.slot, ref, message: `The address /w/${b.value.slug} already belongs to another page.` }));
        }
    }
    return out;
}

async function policyFindings(stage, deps) {
    if (stage.stage !== 'prd' || stage.requiresApproval !== true) return [];
    try {
        await require('./approvalGate').validatePolicy(stage.approvalPolicy, { orgId: stage.organizationId || null, ownerId: stage.runAsUserId }, deps);
        return [];
    } catch (err) {
        if (!err || err.status !== 400) throw err;
        return [finding(stage, {
            code: 'approval_policy.stale', message: err.message,
            remediation: 'Update the approval chain of Production so every stage has an approver who is not the Solution owner.',
        })];
    }
}

/**
 * Every readiness finding of `stage` for this release.
 *
 * @param {{ stage: object, manifest: object, bindings?: Array<{slot, kind, value}>,
 *   values?: Array<{name, value}>, stamps?: Map<string, {entityId: string}> }} input
 * @param {object} [deps]  authorizeConnectionUse, groupsOf, providerForTool, providerAvailable, slugOwner,
 *   validateStages, groupMemberIds
 * @returns {Promise<object[]>}
 */
async function readiness({ stage, manifest, bindings = [], values = [], stamps = null } = /** @type {any} */ ({}), deps = {}) {
    if (!stage) throw new TypeError('readiness: the stage row is required');
    const bindingRows = Array.isArray(bindings) ? bindings : [];
    const byslot = new Map(bindingRows.filter(b => b && b.slot).map(b => [b.slot, b.value]));
    return [
        ...slotFindings(stage, manifest?.solution?.slots, byslot),
        ...variableFindings(stage, manifest?.solution?.variables, values),
        ...(await connectionFindings(stage, bindingRows, deps)),
        ...(await integrationFindings(stage, manifest, deps)),
        ...(await addressFindings(stage, bindingRows, stamps, deps)),
        ...(await policyFindings(stage, deps)),
    ];
}

module.exports = { readiness, requiredProviders };
