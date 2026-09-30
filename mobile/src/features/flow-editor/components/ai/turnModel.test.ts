/**
 * What the assistant sheet says about a turn: its status line as it goes,
 * its activity (with the live test-run row), the plan it keeps, what it did
 * to the draft, and how it failed.
 */

import { emptyBuilderTurn, type BuilderTurn } from '@/features/flow-editor/api';

import { messageActivity, planOf, turnActivity, turnOutcome, turnProblem, turnStatus } from './turnModel';

const t = (_key: string, fallback: string, params?: Record<string, string | number>) =>
    fallback.replace(/\{(\w+)\}/g, (_, k: string) => String(params?.[k] ?? ''));

const turn = (patch: Partial<BuilderTurn>): BuilderTurn => ({ ...emptyBuilderTurn(), ...patch });

it('says what the builder is doing', () => {
    expect(turnStatus(turn({}), t)).toBe('Working…');
    expect(turnStatus(turn({ phase: 'reading' }), t)).toBe('Reading the routine…');
    expect(turnStatus(turn({ phase: 'building', toolDraft: { name: 'builder_add_steps', count: 3 } }), t)).toBe('Building: Steps · 3');
    expect(turnStatus(turn({ phase: 'building', toolDraft: { name: null, count: 0 } }), t)).toBe('Building');
    expect(turnStatus(turn({ thinkingSummary: { text: 'Planning the trigger', seq: 1 } }), t)).toBe('Planning the trigger');
    expect(turnStatus(turn({ layerAgent: 'intake' }), t)).toBe('Building the flowlet “intake”…');
    expect(turnStatus(turn({ thinkingActive: true }), t)).toBe('Thinking…');
    expect(turnStatus(turn({ text: 'Done.' }), t)).toBeNull();
    expect(turnStatus(turn({ done: true }), t)).toBeNull();
});

it('lists what the turn did, with a live row while its test run goes', () => {
    const going = turn({ toolCalls: [{ name: 'builder_add_step', error: null, added: [{ id: 's', type: 'wait', tool: null, label: 'Pause' }] }], dryRun: { run: null, steps: [], running: true } });
    expect(turnActivity(going, t).map((r) => `${r.title}|${r.detail}|${r.status}`)).toEqual(['Wait|Pause|done', 'Testing the routine…||running']);
    expect(turnActivity({ ...going, done: true }, t)).toHaveLength(1);
    expect(messageActivity({ role: 'user', content: 'x', toolCalls: [] }, t)).toEqual([]);
});

it('keeps the live plan, else the session’s', () => {
    const saved = [{ text: 'Old', done: true }];
    expect(planOf([], { todos: saved } as never)).toBe(saved);
    expect(planOf([{ text: 'New', done: false }], { todos: saved } as never)).toEqual([{ text: 'New', done: false }]);
    expect(planOf([], null)).toEqual([]);
});

it('counts what happened to the draft', () => {
    const issue = { code: 'c', severity: 'error' as const, path: 'steps[a]', message: 'm' };
    expect(turnOutcome(turn({ draftCount: 2, validation: { errors: [issue], warnings: [] } }))).toEqual({ drafts: 2, errors: 1, warnings: 0 });
    expect(turnOutcome(turn({}))).toEqual({ drafts: 0, errors: 0, warnings: 0 });
});

it('says how a turn failed, and whether sending again is safe', () => {
    expect(turnProblem(turn({}), t)).toBeNull();
    expect(turnProblem(turn({ error: 'Model overloaded.', transient: true }), t)).toEqual({ text: 'Model overloaded. Your routine is safe — send the message again.', retry: true });
    expect(turnProblem(turn({ error: 'Not allowed' }), t)).toEqual({ text: 'Not allowed', retry: false });
    expect(turnProblem(turn({ aborted: { reason: 'round budget', iterations: 12 } }), t)?.retry).toBe(true);
});
