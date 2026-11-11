/**
 * The privacy check and the ledger row of an http_request step.
 *
 * Everything the author's step would send (the filled path, the query, its own headers and the
 * encoded body) goes through the organisation's privacy pipeline (core/automationRunner/safety,
 * the same one an automation's http_request and a webpage handler use) BEFORE the request is
 * built. This step is stricter than those: whatever the organisation's action is (block,
 * tokenize, redact), a finding fails the step with `pii_blocked` and nothing is sent. There is
 * no rewritten request and no setting that lets one through. A check that could not look at all
 * of it (detector unavailable, content too large to scan) fails the step as well.
 *
 * The policy is resolved the way a webpage handler resolves it: the "apply to automations"
 * switch of the organisation does not turn the check off for an app.
 *
 * Every call that leaves, and every refusal, writes one row to the integration ledger with
 * source `studio_app`, grouped per app.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

export type Obj = Record<string, unknown>;
export type ShieldApp = { id: string; userId: string; organizationId?: string | null; name?: string | null };
export type ShieldVerdict = { ok: true } | { ok: false; code: 'pii_blocked' | 'pii_check_unavailable'; error: string };

type GuardResult = { categories?: unknown; tokenMap?: unknown; markers?: unknown; wouldBlock?: unknown };
type Safety = {
    resolveAutomationPolicy: (ctx: Obj, opts: { honourAutomationOptOut: boolean }) => Promise<Obj>;
    buildAuditBase: (ctx: Obj, step: { id: string }, opts: { source: string }) => Obj;
    guardToolInput: (payload: unknown, policy: Obj, auditBase: Obj, mode: string, ctx: Obj) => Promise<GuardResult>;
    logEgress: (entry: Obj) => Promise<void>;
};

export type ShieldSession = { ctx: Obj; policy: Obj; auditBase: Obj; meta: Obj; safety: Safety };
export type ShieldDeps = { safety?: Safety };

const SOURCE = 'studio_app';
const TOOL = 'http_request';
const LIVE = 'live';
/** A marker that means part of the content was not looked at. */
const UNCHECKED_MARKERS = ['privacy_protection_unavailable', 'scan_overflow'];
/** A marker for a finding the pipeline let through on its own (an id-like field). */
const PASSED_MARKERS = ['identifier_passed_unredacted'];

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);

/** The policy and the audit identity of one step run. */
export async function openShield(app: ShieldApp, actionId: unknown, target: { origin: string; hostname: string; write: boolean }, deps: ShieldDeps = {}): Promise<ShieldSession> {
    const safety = deps.safety ?? (nodeRequire('../../../core/automationRunner/safety.js') as Safety);
    const ctx: Obj = {
        orgId: app.organizationId || null,
        userId: app.userId,
        // Grouped per app in the ledger, the way an automation's rows group per automation.
        automationId: app.id,
        automationTitle: app.name || null,
        runId: null,
    };
    const policy = await safety.resolveAutomationPolicy(ctx, { honourAutomationOptOut: false });
    const auditBase = safety.buildAuditBase(ctx, { id: `studio_app:${app.id}:${typeof actionId === 'string' ? actionId : '-'}` }, { source: SOURCE });
    const meta = {
        integration: TOOL, label: target.hostname, server: target.origin,
        direction: target.write ? 'outbound' : 'both', dataCategories: 'auto_detected', isLocal: false,
    };
    return { ctx, policy, auditBase, meta, safety };
}

function found(categories: string[]): ShieldVerdict {
    const what = categories.length ? ` (${categories.slice(0, 8).join(', ')})` : '';
    return { ok: false, code: 'pii_blocked', error: `The privacy check found personal data${what} in what this step would send. Nothing was sent.` };
}

const unchecked = (): ShieldVerdict => ({
    ok: false, code: 'pii_check_unavailable',
    error: 'The privacy check could not look at everything this step would send, so nothing was sent.',
});

async function logRefusal(session: ShieldSession, error: unknown): Promise<void> {
    const { safety, policy, auditBase, meta } = session;
    await safety.logEgress({ toolName: TOOL, toolArgs: {}, blocked: true, error, policy, auditBase, mode: LIVE, integMeta: meta, durationMs: 0 });
}

/**
 * May `texts` leave? They are handed over as a flat list, so no text is ever taken for an
 * addressing id that the pipeline would let through.
 */
export async function checkOutbound(session: ShieldSession, texts: string[]): Promise<ShieldVerdict> {
    const { safety, policy, auditBase, ctx } = session;
    const payload = texts.filter((t) => t !== '');
    if (!payload.length) return { ok: true };
    let guarded: GuardResult;
    try {
        guarded = await safety.guardToolInput(payload, policy, auditBase, LIVE, ctx);
    } catch (e) {
        const err = e as { guardrailBlocked?: unknown; violationType?: unknown; categories?: unknown };
        if (!err || err.guardrailBlocked !== true) throw e;
        await logRefusal(session, e);
        return err.violationType === 'scan_failed' ? unchecked() : found(list(err.categories));
    }
    const markers = list(guarded.markers);
    const categories = list(guarded.categories);
    const refused = categories.length > 0 || guarded.tokenMap != null || guarded.wouldBlock === true || markers.some((m) => PASSED_MARKERS.includes(m));
    const blind = markers.some((m) => UNCHECKED_MARKERS.includes(m));
    if (!refused && !blind) return { ok: true };
    await logRefusal(session, new Error(refused ? 'personal data found' : 'privacy check incomplete'));
    return refused ? found(categories) : unchecked();
}

/** The ledger row of a call that was sent (answered or failed). Never carries a header or a body. */
export async function logCall(session: ShieldSession, call: { url: string; method: string; status?: number; error?: unknown; probe?: unknown; ms: number }): Promise<void> {
    const { safety, policy, auditBase, meta } = session;
    await safety.logEgress({
        toolName: TOOL, toolArgs: { url: call.url, method: call.method },
        ...(call.error !== undefined ? { error: call.error } : { result: { status: call.status } }),
        probe: call.probe ?? null, policy, auditBase, mode: LIVE, integMeta: meta, durationMs: call.ms,
    });
}
