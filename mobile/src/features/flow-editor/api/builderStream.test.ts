/**
 * The builder adapter frame by frame, through the shared reducer: the reply
 * and the reasoning build up, a draft and the findings reach the callbacks as
 * they arrive, the dry run and the checklist land on the turn, and `error`
 * and `done` end it.
 */

import { reduceFrame } from '@/shared/stream';

import { builderFrames, emptyBuilderTurn, type BuilderFrameCallbacks, type BuilderTurn } from './builderStream';

function play(frames: [string, unknown][], callbacks: BuilderFrameCallbacks = {}) {
    const adapter = builderFrames(() => callbacks);
    const turn: BuilderTurn = emptyBuilderTurn();
    const sink = { mark: jest.fn(), onUnhandled: jest.fn() };
    for (const [event, data] of frames) reduceFrame(adapter, turn, { event, data }, sink);
    return { turn, sink };
}

const DEF = { trigger: { id: 'trg', type: 'trigger', kind: 'manual' }, steps: [{ id: 's1', type: 'set' }], edges: [] };

describe('the builder turn', () => {
    it('builds the reply, the reasoning, the tool calls and the checklist', () => {
        const { turn, sink } = play([
            ['builder_session', { builderSessionId: 'bs1', automationId: 'a1' }],
            ['round_start', { modelId: 'm1', iter: 0 }],
            ['thinking_start', { partId: 't0' }],
            ['thinking', { partId: 't0', text: 'Let me ' }],
            ['thinking', { partId: 't0', text: 'think.' }],
            ['thinking_summary', { text: 'Planning the trigger', seq: 2 }],
            ['thinking_summary', { text: 'stale', seq: 1 }],
            ['thinking_stop', { partId: 't0' }],
            ['tool_draft', { name: 'builder_add_steps', count: 3 }],
            ['tool_call', { name: 'builder_add_steps', arguments: {}, result: { error: 'refused' } }],
            ['plan', { todos: [{ text: 'Add trigger', done: true }, { text: '' }] }],
            ['message', { content: 'Done ' }],
            ['message', { content: 'building.' }],
            ['ping', {}],
            ['usage', { prompt_tokens: 5 }],
            ['prompt_progress', { total: 9 }],
        ]);
        expect(turn).toMatchObject({
            builderSessionId: 'bs1',
            automationId: 'a1',
            modelId: 'm1',
            thinking: 'Let me think.',
            thinkingActive: false,
            thinkingSummary: { text: 'Planning the trigger', seq: 2 },
            toolDraft: null,
            toolCalls: [{ name: 'builder_add_steps', error: 'refused' }],
            todos: [{ text: 'Add trigger', done: true }],
            text: 'Done building.',
            phase: null,
        });
        expect(sink.onUnhandled).not.toHaveBeenCalled();
    });

    it('hands the automation’s frames to the callbacks as they arrive', () => {
        const callbacks = {
            onSession: jest.fn(),
            onDraft: jest.fn(),
            onValidation: jest.fn(),
            onFinalized: jest.fn(),
            onMetadata: jest.fn(),
        };
        const { turn } = play(
            [
                ['builder_session', { builderSessionId: 'bs1', automationId: 'a1' }],
                ['draft', { definition: DEF, automationId: 'a1' }],
                ['draft', { definition: 'not a definition' }],
                ['validation_errors', { errors: [{ code: 'x', path: 'steps[s1]', message: 'Broken' }], warnings: [] }],
                ['metadata', { automationId: 'a1', title: 'Invoice inbox' }],
                ['finalized', { automationId: 'a1' }],
            ],
            callbacks,
        );
        expect(callbacks.onSession).toHaveBeenCalledWith({ automationId: 'a1', builderSessionId: 'bs1' });
        expect(callbacks.onDraft).toHaveBeenCalledTimes(1);
        expect(callbacks.onDraft).toHaveBeenCalledWith(DEF, 'a1');
        expect(callbacks.onValidation).toHaveBeenCalledWith({
            errors: [{ severity: 'error', code: 'x', path: 'steps[s1]', message: 'Broken' }],
            warnings: [],
        });
        expect(callbacks.onMetadata).toHaveBeenCalledWith('Invoice inbox');
        expect(callbacks.onFinalized).toHaveBeenCalledWith('a1');
        expect(turn).toMatchObject({ draftCount: 1, title: 'Invoice inbox', finalizedId: 'a1' });
    });

    it('follows the AI’s dry run from start to rows', () => {
        const started = play([['dryrun_started', { run: { id: 'r1', status: 'running' } }]]).turn;
        expect(started.dryRun).toEqual({ run: null, steps: [], running: true });
        const { turn } = play([
            ['dryrun_started', { run: { id: 'r1' } }],
            ['dryrun', { run: { id: 'r1', status: 'success' }, steps: [{ stepId: 's1', status: 'success' }] }],
            ['summary', { summary: 'Sends a mail', hasSideEffects: true }],
        ]);
        expect(turn.dryRun?.running).toBe(false);
        expect(turn.dryRun?.run?.id).toBe('r1');
        expect(turn.dryRun?.steps.map((s) => s.stepId)).toEqual(['s1']);
        expect(turn.summary).toEqual({ text: 'Sends a mail', hasSideEffects: true });
    });

    it('names a delegated flowlet while its agent works, and an abort', () => {
        const during = play([['layer_agent_start', { layerKey: 'invoices' }]]).turn;
        expect(during.layerAgent).toBe('invoices');
        const { turn } = play([
            ['layer_agent_start', { layerKey: 'invoices' }],
            ['layer_agent_done', { layerKey: 'invoices' }],
            ['builder_aborted', { reason: 'max_iterations', iterations: 24 }],
        ]);
        expect(turn.layerAgent).toBeNull();
        expect(turn.aborted).toEqual({ reason: 'max_iterations', iterations: 24 });
    });

    it('an error ends the turn and says whether sending again is enough', () => {
        const { turn } = play([['error', { error: 'The AI provider had a temporary problem.', transient: true }]]);
        expect(turn).toMatchObject({ error: 'The AI provider had a temporary problem.', transient: true, done: true });
        expect(play([['error', {}]]).turn.error).toBe('The builder reported an error.');
    });

    it('done ends the turn and carries the finalisation', () => {
        const { turn } = play([
            ['thinking_start', {}],
            ['done', { automationId: 'a1', finalized: true, iterations: 3 }],
        ]);
        expect(turn).toMatchObject({ done: true, thinkingActive: false, finalizedId: 'a1' });
    });

    it('replays a resumed session', () => {
        const { turn } = play([['resume', { snapshot: { sessionId: 'bs1', conversation: [{ role: 'user', content: 'hi' }] } }]]);
        expect(turn.resumed?.sessionId).toBe('bs1');
        expect(turn.resumed?.conversation).toHaveLength(1);
    });
});
