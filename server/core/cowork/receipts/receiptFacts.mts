/**
 * What a Cowork run's receipt says (stores/coworkReceipts.mts keeps it, usecases/coworkReceipts.mts issues it): which
 * run, how it started and ended, which approved plan it executed, what that plan was allowed to do, who approved it,
 * how independent it ran, and what it did, as apps, tool names and counts.
 *
 * Built from an explicit allow-list of fields, never by removing keys from a row: no text a run read or wrote, no
 * address, no subject, no tool arguments, no error message. Total: whatever arrives, a receipt comes out, so issuing
 * one can never fail a run's close.
 */

import type { Definition, DefStep, Effect, ToolLookups } from '../plan/planTypes.mts';
import { stepsOf } from '../plan/planWalk.mts';
import type { ReceiptPlan, ReceiptRun } from '../../../stores/coworkReceipts.mts';

export const RECEIPT_VERSION = 1;
const MAX_LINES = 100;
const EFFECTS: readonly Effect[] = ['reads', 'writes', 'sends'];

export interface DidLine { app: string; tool: string; effect: Effect; count: number }
export interface MayLine { app: string; effect: Effect }

export interface ReceiptPayload {
    v: number;
    runId: string;
    itemId: string;
    kind: 'plan' | 'agent' | 'prompt';
    status: string;
    start: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    plan: { version: number; fingerprint: string; approvedBy: string; approvedAt: string | null } | null;
    may: MayLine[];
    sends: 'none' | 'owner' | 'others' | null;
    independence: string | null;
    trustedSteps: number;
    did: DidLine[];
}

export interface ReceiptInput {
    run: ReceiptRun;
    plan: ReceiptPlan | null;
    /** A plan run's steps: how often each succeeded. */
    steps: Array<{ stepId: string; stepType: string; succeeded: number }>;
    lookups: ToolLookups;
}

const text = (v: unknown, max = 200): string | null => (typeof v === 'string' && v ? v.slice(0, max) : null);
const isEffect = (v: unknown): v is Effect => typeof v === 'string' && (EFFECTS as readonly string[]).includes(v);

/** The apps and effects the approved plan may use, as stored at approval. */
function mayOf(permissions: unknown): MayLine[] {
    const grants = permissions && typeof permissions === 'object' ? (permissions as { grants?: unknown }).grants : null;
    if (!Array.isArray(grants)) return [];
    const lines = grants
        .map((g) => (g && typeof g === 'object' ? g as { app?: unknown; effect?: unknown } : {}))
        .filter((g) => typeof g.app === 'string' && isEffect(g.effect))
        .map((g) => ({ app: (g.app as string).slice(0, 100), effect: g.effect as Effect }));
    return lines.slice(0, MAX_LINES);
}

function sendsOf(permissions: unknown): ReceiptPayload['sends'] {
    const sends = permissions && typeof permissions === 'object' ? (permissions as { sends?: unknown }).sends : null;
    return sends === 'none' || sends === 'owner' || sends === 'others' ? sends : null;
}

/** An agent's or a prompt's tool calls that went through, from the run's activity. */
function didOfActivity(activity: unknown, lookups: ToolLookups): DidLine[] {
    const tools = activity && typeof activity === 'object' ? (activity as { tools?: unknown }).tools : null;
    if (!Array.isArray(tools)) return [];
    const lines: DidLine[] = [];
    for (const t of tools) {
        const row = t && typeof t === 'object' ? t as { name?: unknown; app?: unknown; ok?: unknown } : {};
        const tool = text(row.name, 120);
        const count = typeof row.ok === 'number' && row.ok > 0 ? row.ok : 0;
        if (!tool || count === 0) continue;
        lines.push({ app: text(row.app, 100) ?? lookups.appOfTool(tool) ?? 'bee-flow', tool, effect: lookups.effectOfTool(tool), count });
    }
    return lines;
}

/** The tool a plan step calls, if it calls one. */
function toolOfStep(step: DefStep): string | null {
    const s = step as { tool?: unknown; type?: unknown };
    if (typeof s.tool === 'string' && s.tool) return s.tool;
    return s.type === 'notification' ? 'notification' : null;
}

/** A plan run's steps that went through and called an app, from the approved definition and the run's step rows. */
function didOfPlan(definition: unknown, steps: ReceiptInput['steps'], lookups: ToolLookups): DidLine[] {
    const byId = new Map(stepsOf(definition as Definition).map((w) => [w.id, w.step]));
    const lines: DidLine[] = [];
    for (const s of steps) {
        const step = byId.get(s.stepId);
        const tool = step ? toolOfStep(step) : null;
        if (!tool || s.succeeded === 0) continue;
        const effect: Effect = tool === 'notification' ? 'sends' : lookups.effectOfTool(tool);
        lines.push({ app: tool === 'notification' ? 'bee-flow' : lookups.appOfTool(tool) ?? 'bee-flow', tool, effect, count: s.succeeded });
    }
    return lines;
}

/** Lines of the same app, tool and effect are one line; sorted, so the same run always gives the same receipt. */
function merged(lines: DidLine[]): DidLine[] {
    const by = new Map<string, DidLine>();
    for (const l of lines) {
        const key = `${l.app}\u0000${l.tool}\u0000${l.effect}`;
        const had = by.get(key);
        by.set(key, had ? { ...had, count: had.count + l.count } : { ...l });
    }
    return [...by.values()].sort((a, b) => a.app.localeCompare(b.app) || a.tool.localeCompare(b.tool) || a.effect.localeCompare(b.effect)).slice(0, MAX_LINES);
}

function kindOf(run: ReceiptRun): ReceiptPayload['kind'] {
    if (run.planId || run.automationRunId) return 'plan';
    return run.conversationId ? 'agent' : 'prompt';
}

/** The receipt of one closed run. Never throws. */
export function receiptFacts({ run, plan, steps, lookups }: ReceiptInput): ReceiptPayload {
    let did: DidLine[] = [];
    try {
        did = merged(kindOf(run) === 'plan' ? didOfPlan(plan?.definition, steps, lookups) : didOfActivity(run.activity, lookups));
    } catch {
        did = [];
    }
    return {
        v: RECEIPT_VERSION,
        runId: run.id,
        itemId: run.scheduleId,
        kind: kindOf(run),
        status: text(run.status, 40) ?? 'unknown',
        start: text(run.triggerKind, 40),
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        plan: plan ? { version: plan.version, fingerprint: text(plan.fingerprint, 128) ?? '', approvedBy: text(plan.approvedBy, 200) ?? '', approvedAt: plan.approvedAt } : null,
        may: plan ? mayOf(plan.permissions) : [],
        sends: plan ? sendsOf(plan.permissions) : null,
        independence: text(run.independence, 40),
        trustedSteps: run.trustedSteps.length,
        did,
    };
}
