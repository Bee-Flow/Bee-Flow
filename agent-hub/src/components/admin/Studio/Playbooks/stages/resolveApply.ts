import type { TranslateFn } from '../../../../../hooks/useTranslation';
import type { ResolveCall, ResolvePlan } from './compliance.types';
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
export const CALL_KINDS: Readonly<Record<string, string>> = Object.freeze({
    register: 'the processing register',
    automation_definition: 'the automation',
    app_publish: 'who can open the app',
    app_member: 'a role for a person',
    org_settings: 'the Compliance Center',
});

/** The writes a page hands in, one per kind of call (see `deps` below). */
export interface ResolveDeps {
    register?: (body: Record<string, unknown>) => Promise<{ failed?: Array<{ error?: string; what?: string }> } | null>;
    saveAutomation?: (id: string, definition: unknown) => Promise<unknown>;
    publish?: (appId: string, body: { isPublished: boolean; sharedGroups: string[] }) => Promise<unknown>;
    assignMember?: (userId: string, roleKey: string) => Promise<unknown>;
    saveComplianceSettings?: (body: Record<string, unknown>) => Promise<unknown>;
}

/** The fields the calls' bodies carry that this file reads. */
type ResolveCallBody = {
    automationId: string;
    definition: unknown;
    appId: string;
    isPublished: boolean;
    sharedGroups?: string[];
    userId: string;
    roleKey: string;
};

/** What a thrown write carries when it came from a request. */
interface ReadableError {
    status?: number;
    message?: string;
    body?: { errors?: Array<string | { message?: string; error?: string } | null> } | null;
}

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
export async function applyResolvePlan(plan: ResolvePlan, deps: ResolveDeps = {}) {
    const applied: Array<string | undefined> = [];
    const failed: Array<{ what: string; kind: string | undefined; error: string }> = [];
    const calls = Array.isArray(plan && plan.calls) ? plan.calls : [];
    for (const call of calls) {
        const what = (call && call.kind && CALL_KINDS[call.kind]) || (call && call.kind) || 'something';
        try {
            await dispatch(call, deps);
            applied.push(call.kind);
        } catch (e) {
            failed.push({ what, kind: call && call.kind, error: readable(e as ReadableError) });
        }
    }
    return { applied, failed, ok: !failed.length && !!applied.length };
}

/** The one place a kind becomes a call. Anything unknown is refused loudly. */
async function dispatch(call: ResolveCall, deps: ResolveDeps) {
    const body = ((call && call.body) || {}) as ResolveCallBody;
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
export function readable(e: ReadableError | null | undefined) {
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
export function resolveSummary(out: { applied: Array<string | undefined>; failed: { what: string; kind: string | undefined; error: string }[]; ok: boolean }, t: TranslateFn) {
    if (!out) return '';
    if (out.failed.length && !out.applied.length) {
        return t('playbooks.compliance.fix_failed', 'Nothing was changed — {why}', { why: out.failed.map((f) => `${f.what}: ${f.error}`).join(', ') });
    }
    if (out.failed.length) {
        return t('playbooks.compliance.fix_partial', 'Partly done — {why} did not go through.', { why: out.failed.map((f) => f.what).join(', ') });
    }
    return t('playbooks.compliance.fix_done', 'Done. Reading it again…');
}
