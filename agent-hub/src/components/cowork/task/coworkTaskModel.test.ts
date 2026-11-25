// What an opened task says, from what the server sent (./coworkTaskModel.ts): its steps in run order with a kind word
// and an app, never a tool name; what its last run did; and each run in one line.
import { describe, expect, it } from 'vitest';
import { inRunOrder, planSteps, runLine, runReason, runStatus, runSteps, stepWord, taskModeOf } from './coworkTaskModel';
import type { PlanState, PlanStep } from '@/api/coworkPlan.types';
import type { CoworkRun } from '@/api/cowork.types';

const t = (_key: string | undefined, fallback?: unknown, params?: unknown) => {
    let text = typeof fallback === 'string' ? fallback : '';
    for (const [k, v] of Object.entries((params ?? (typeof fallback === 'object' ? fallback : {})) as Record<string, unknown>)) text = text.replaceAll(`{${k}}`, String(v));
    return text;
};

const step = (id: string, over: Partial<PlanStep> = {}): PlanStep => ({
    id, type: 'integration_action', kind: 'fixed', title: id, effect: 'reads', app: 'outlook', tool: 'outlook_search', readsOutsideText: false, depth: 0, ...over,
});

const planOf = (steps: PlanStep[], runOrder?: string[], over: Partial<PlanState> = {}): PlanState => ({
    automationId: 'a1',
    draft: { view: { trigger: 'schedule', steps, runOrder, makeUp: { fixed: 0, ai: 0, ask: 0, deliver: 0 } }, permissions: { v: 1, grants: [], sends: 'owner', ai: true, outsideText: false }, findings: [], fingerprint: 'f'.repeat(64) },
    approved: null, widens: [], upToDate: false, ...over,
});

describe('coworkTaskModel', () => {
    it('lists the steps in run order: the order of the edges, not of the definition', () => {
        const plan = planOf([step('write', { kind: 'ai', title: 'Write the digest' }), step('read', { title: 'Read the mail' }), step('tell', { kind: 'deliver', effect: 'sends', app: null, title: 'Tell me' })], ['read', 'write', 'tell']);
        expect(planSteps(plan, t).map((s) => s.title)).toEqual(['Read the mail', 'Write the digest', 'Tell me']);
    });

    it('keeps the definition order from a server that sends no run order, and puts unknown ids last', () => {
        expect(inRunOrder([{ id: 'a' }, { id: 'b' }], undefined).map((s) => s.id)).toEqual(['a', 'b']);
        expect(inRunOrder([{ id: 'x' }, { id: 'b' }, { id: 'a' }], ['a', 'b']).map((s) => s.id)).toEqual(['a', 'b', 'x']);
    });

    it('gives each step its kind word and its app, an in-between step its own word, and marks a changed one', () => {
        const plan = planOf([
            step('read'), step('trim', { type: 'filter', helper: true, app: null, tool: null }), step('draft', { effect: 'writes' }),
            step('sum', { kind: 'ai', app: null }), step('mail', { effect: 'sends' }),
        ], undefined, { approved: { version: 1, fingerprint: 'e'.repeat(64), approvedAt: null, permissions: { v: 1, grants: [], sends: 'others', ai: true, outsideText: false } }, stepChanges: [{ id: 'draft', title: 'draft', kind: 'fixed', change: 'changed' }] });
        const steps = planSteps(plan, t);
        expect(steps.map((s) => [stepWord(s, t), s.app, s.changed])).toEqual([
            ['Reads', 'Outlook', false], ['In-between step', null, false], ['Changes', 'Outlook', true], ['AI writes or decides', null, false], ['Sends', 'Outlook', false],
        ]);
    });

    it('names who a step that sends reaches: you, the addresses the steps fix, or the ones it picks', () => {
        const plan = planOf([step('tell', { kind: 'deliver', effect: 'sends', app: null }), step('mail', { effect: 'sends' }), step('each', { effect: 'sends' }), step('old', { effect: 'sends' })]);
        if (plan.draft) plan.draft.recipients = { tell: 'owner', mail: 'bo@x.example,sam@x.example', each: '*' };
        expect(planSteps(plan, t).map((s) => stepWord(s, t))).toEqual(['Sends to you', 'Sends to bo@x.example, sam@x.example', 'Sends to the addresses it picks', 'Sends']);
    });

    it('puts a run in the one status vocabulary', () => {
        const run = (over: Partial<CoworkRun>) => runStatus({ status: 'success', ...over });
        expect([run({}), run({ producedOutput: false }), run({ status: 'error' }), run({ status: 'running' }), run({ status: 'waiting' })]).toEqual(['done', 'nothing', 'failed', 'running', 'needs']);
        expect(run({ review: { reason: 'Check this', question: null, summary: null, resolution: null, resolvedBy: null, resolvedAt: null } })).toBe('needs');
    });

    it('shows what the AI did last time with the tools\' labels, never their names, and leaves Cowork\'s own tools out', () => {
        const run = {
            id: 'r1', status: 'success', startedAt: '2026-11-23T08:00:00Z',
            activity: { toolCalls: 3, skills: [], tools: [
                { name: 'outlook_search', app: 'outlook', ok: 1, failed: 0, refused: 0, reasons: [], label: 'Outlook: search', effect: 'reads' },
                { name: 'teams_post_message', app: 'teams', ok: 1, failed: 0, refused: 0, reasons: [], effect: 'sends' },
                { name: 'cowork_report_outcome', app: null, ok: 1, failed: 0, refused: 0, reasons: [], internal: true },
            ] },
        } as CoworkRun;
        expect(runSteps(run, t).map((s) => [s.title, stepWord(s, t)])).toEqual([['Outlook: search', 'Reads'], ['Teams post message', 'Sends'], ['Write the result', 'AI writes or decides']]);
    });

    it('says how a task works and what a run came to, in one line', () => {
        expect(taskModeOf({ agentId: null }, planOf([]))).toBe('steps');
        expect(taskModeOf({ agentId: 'ag1' }, { ...planOf([]), automationId: null })).toBe('agent');
        expect(taskModeOf({ agentId: null }, undefined)).toBe('ai');
        const base = { id: 'r', startedAt: '2026-11-23T08:00:00Z' };
        expect(runLine({ ...base, status: 'success', producedOutput: false }, t)).toBe('Nothing to do this time.');
        expect(runLine({ ...base, status: 'success', result: '## Digest\n- 3 invoices overdue' }, t)).toBe('Digest');
    });

    it('never puts a raw error in what a person reads: the server\'s plain sentence, else a general one', () => {
        const failed = { id: 'r', startedAt: '2026-11-23T08:00:00Z', status: 'error', error: 'datetime: input "{{steps.dt1.output.iso}}" did not resolve' };
        expect(runLine(failed, t)).toBe('It stopped before it was done.');
        expect(runReason(failed, t)).toBe('This run stopped before it was done. What it had already done stays done.');
        const told = { ...failed, plain: "The step 'A week ago' could not work out its date." };
        expect(runLine(told, t)).toBe("The step 'A week ago' could not work out its date.");
        expect(runReason(told, t)).toBe("The step 'A week ago' could not work out its date.");
        expect(runLine({ ...failed, status: 'success', error: null, plain: 'Wrote the overview for you.', result: 'Long text' }, t)).toBe('Wrote the overview for you.');
    });
});
