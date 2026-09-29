/**
 * Applying an approved fix — pure, so the order and the failure behaviour are
 * testable without a network.
 *
 * The server proposed; nothing here decides anything. Each call in the plan
 * names a KIND, never a URL, and this turns that kind into the one endpoint
 * that already owns and audits that write: the table through the playbook's
 * own register route, an automation through the automations API, the app
 * through the app's own owner-only routes, the organisation's settings through
 * the Compliance Center. Same shape as accessApply.js next door, for the same
 * reason — one failure must never cost the rest.
 */

/** What a call of each kind needs, and what it is called in front of a person. */
export const CALL_KINDS = Object.freeze({
    register: 'the processing register',
    automation_definition: 'the automation',
    app_publish: 'who can open the app',
    app_member: 'a role for a person',
    org_settings: 'the Compliance Center',
});

/**
 * `deps`:
 *   register(body)                       — POST the phase's own register route
 *   saveAutomation(id, definition)       — PUT /api/automation/:id
 *   publish(appId, body)                 — PATCH /api/studio-apps/:id/publish
 *   assignMember(userId, roleKey)        — POST /api/studio-apps/:id/members
 *   saveComplianceSettings(body)         — PUT /api/compliance/settings
 * A dep that is missing is not a silent skip: the call fails by name, so the
 * person is told which part of the fix did not happen.
 */
export async function applyResolvePlan(plan, deps = {}) {
    const applied = [];
    const failed = [];
    const calls = Array.isArray(plan && plan.calls) ? plan.calls : [];
    for (const call of calls) {
        const what = CALL_KINDS[call && call.kind] || (call && call.kind) || 'something';
        try {
            await dispatch(call, deps);
            applied.push(call.kind);
        } catch (e) {
            failed.push({ what, kind: call && call.kind, error: readable(e) });
        }
    }
    return { applied, failed, ok: !failed.length && !!applied.length };
}

/** The one place a kind becomes a call. Anything unknown is refused loudly. */
async function dispatch(call, deps) {
    const body = (call && call.body) || {};
    switch (call && call.kind) {
        case 'register': {
            if (!deps.register) throw new Error('missing');
            const out = await deps.register(body);
            // The register route reports partial success rather than throwing.
            const bad = (out && Array.isArray(out.failed) ? out.failed : []).filter(Boolean);
            if (bad.length) throw new Error(bad.map((f) => f.error || f.what).join('; '));
            return out;
        }
        case 'automation_definition':
            if (!deps.saveAutomation) throw new Error('missing');
            return deps.saveAutomation(body.automationId, body.definition);
        case 'app_publish':
            if (!deps.publish) throw new Error('missing');
            return deps.publish(body.appId, { isPublished: body.isPublished, sharedGroups: body.sharedGroups || [] });
        case 'app_member':
            if (!deps.assignMember) throw new Error('missing');
            return deps.assignMember(body.userId, body.roleKey);
        case 'org_settings':
            if (!deps.saveComplianceSettings) throw new Error('missing');
            return deps.saveComplianceSettings(body);
        default:
            throw new Error(`unknown change "${(call && call.kind) || '—'}"`);
    }
}

/**
 * The sentence a person gets when a write is refused.
 *
 * A 403 here is not a bug and should not read like one: the org's compliance
 * settings need compliance-admin rights, which the person running a playbook
 * may simply not have. Saying so is the whole answer.
 */
export function readable(e) {
    const status = e && e.status;
    if (status === 403) return 'you do not have the rights for this one';
    if (status === 409) return 'someone changed it while you were reading — try again';
    if (status === 422 || status === 400) {
        const errs = e && e.body && Array.isArray(e.body.errors) ? e.body.errors : null;
        if (errs && errs.length) return errs.map((x) => (typeof x === 'string' ? x : (x && (x.message || x.error)) || '')).filter(Boolean).join('; ');
    }
    if (e && e.message === 'missing') return 'this page cannot make that change';
    return (e && e.message) || 'it did not go through';
}

/** One line for the row after an Apply: what changed, or what did not. */
export function resolveSummary(out, t) {
    if (!out) return '';
    if (out.failed.length && !out.applied.length) {
        return t('playbooks.compliance.fix_failed', 'Nothing was changed — {why}', { why: out.failed.map((f) => `${f.what}: ${f.error}`).join(', ') });
    }
    if (out.failed.length) {
        return t('playbooks.compliance.fix_partial', 'Partly done — {why} did not go through.', { why: out.failed.map((f) => f.what).join(', ') });
    }
    return t('playbooks.compliance.fix_done', 'Done. Reading it again…');
}
