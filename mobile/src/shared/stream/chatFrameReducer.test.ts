/**
 * The reducer's three outcomes — routed, ignored on purpose, unknown — and the
 * per-surface differences the adapters exist to keep. The four surfaces used
 * to be four copies of one switch; these tests are what stops them drifting
 * again, one assertion per place where they are allowed to differ.
 */

import { AGENT_FRAMES, emptyAgentTurn } from './adapters/agent';
import { DIRECT_FRAMES, emptyStreamingTurn } from './adapters/direct';
import { emptyLibraryTurn, libraryFrames } from './adapters/library';
import { emptyMeetingTurn, MEETING_FRAMES } from './adapters/meeting';
import { accounts, IGNORE, reduceFrame, type FrameAdapter } from './chatFrameReducer';

/** Fold a list of frames; report what marked and what was unknown. */
function fold<S>(adapter: FrameAdapter<S>, turn: S, frames: [string, unknown?][]) {
    const marks: string[] = [];
    const unknown: string[] = [];
    for (const [event, data] of frames) {
        let marked = false;
        reduceFrame(adapter, turn, { event, data: data ?? {} }, {
            mark: () => {
                marked = true;
            },
            onUnhandled: (e) => unknown.push(e),
        });
        if (marked) marks.push(event);
    }
    return { turn, marks, unknown };
}

describe('reduceFrame', () => {
    const adapter: FrameAdapter<{ n: number }> = {
        bump: (turn) => {
            turn.n += 1;
        },
        same: () => false,
        quiet: IGNORE,
    };

    it('marks after a handler that changed the turn, and not after one that says it did not', () => {
        const { turn, marks } = fold(adapter, { n: 0 }, [['bump'], ['same'], ['quiet']]);
        expect(turn.n).toBe(1);
        expect(marks).toEqual(['bump']);
    });

    it('reports an unknown event, never an ignored one', () => {
        const { unknown } = fold(adapter, { n: 0 }, [['quiet'], ['next_year', { a: 1 }]]);
        expect(unknown).toEqual(['next_year']);
    });

    it('does not find Object.prototype members as handlers', () => {
        const { unknown } = fold(adapter, { n: 0 }, [['constructor'], ['toString'], ['hasOwnProperty']]);
        expect(unknown).toEqual(['constructor', 'toString', 'hasOwnProperty']);
        expect(accounts(adapter, 'constructor')).toBe(false);
    });

    it('reads a payload that is not an object as an empty one', () => {
        const turn = emptyStreamingTurn();
        reduceFrame(DIRECT_FRAMES, turn, { event: 'content', data: 'not json' }, { mark: () => {} });
        reduceFrame(DIRECT_FRAMES, turn, { event: 'content', data: null }, { mark: () => {} });
        expect(turn.text).toBe('');
    });
});

describe('the answer text', () => {
    const frames: [string, unknown?][] = [
        ['content', { text: 'Hello' }],
        ['content', { text: ' world' }],
    ];

    it('accumulates on every surface', () => {
        expect(fold(DIRECT_FRAMES, emptyStreamingTurn(), frames).turn.text).toBe('Hello world');
        expect(fold(AGENT_FRAMES, emptyAgentTurn(), frames).turn.text).toBe('Hello world');
        expect(fold(libraryFrames(() => ({})), emptyLibraryTurn(), frames).turn.text).toBe('Hello world');
        expect(fold(MEETING_FRAMES, emptyMeetingTurn(), frames).turn.text).toBe('Hello world');
    });

    it('lets an empty content_replace blank the answer on direct, notebook and meeting, but not on agents', () => {
        const blanking: [string, unknown?][] = [...frames, ['content_replace', { text: '' }]];
        expect(fold(DIRECT_FRAMES, emptyStreamingTurn(), blanking).turn.text).toBe('');
        expect(fold(libraryFrames(() => ({})), emptyLibraryTurn(), blanking).turn.text).toBe('');
        expect(fold(MEETING_FRAMES, emptyMeetingTurn(), blanking).turn.text).toBe('');
        expect(fold(AGENT_FRAMES, emptyAgentTurn(), blanking).turn.text).toBe('Hello world');
    });

    it('keeps the answer on an empty content_redact everywhere but the meeting sheet', () => {
        const redacting: [string, unknown?][] = [...frames, ['content_redact', {}]];
        expect(fold(DIRECT_FRAMES, emptyStreamingTurn(), redacting).turn.text).toBe('Hello world');
        expect(fold(AGENT_FRAMES, emptyAgentTurn(), redacting).turn.text).toBe('Hello world');
        expect(fold(libraryFrames(() => ({})), emptyLibraryTurn(), redacting).turn.text).toBe('Hello world');
        expect(fold(MEETING_FRAMES, emptyMeetingTurn(), redacting).turn.text).toBe('');
    });

    it('does not re-render the meeting sheet for an empty chunk', () => {
        expect(fold(MEETING_FRAMES, emptyMeetingTurn(), [['content', {}]]).marks).toEqual([]);
    });
});

describe('reasoning', () => {
    it('reads `thinking` as well as `text` on direct and agent turns, only `text` on notebooks', () => {
        const frames: [string, unknown?][] = [['thinking', { thinking: 'a' }], ['thinking', { text: 'b' }]];
        expect(fold(DIRECT_FRAMES, emptyStreamingTurn(), frames).turn.thinking).toBe('ab');
        expect(fold(AGENT_FRAMES, emptyAgentTurn(), frames).turn.thinking).toBe('ab');
        expect(fold(libraryFrames(() => ({})), emptyLibraryTurn(), frames).turn.thinking).toBe('b');
    });

    it('goes quiet at done', () => {
        const turn = fold(DIRECT_FRAMES, emptyStreamingTurn(), [['thinking_start'], ['done']]).turn;
        expect(turn).toMatchObject({ thinkingActive: false, done: true });
    });
});

describe('progress', () => {
    it('reads { stage, status, detail } on direct and agents: a live line and a durable trail', () => {
        for (const [adapter, empty] of [
            [DIRECT_FRAMES, emptyStreamingTurn],
            [AGENT_FRAMES, emptyAgentTurn],
        ] as const) {
            const live = fold(adapter as FrameAdapter<ReturnType<typeof empty>>, empty(), [
                ['phase', { stage: 'kb_search', status: 'start', detail: 'HR' }],
            ]).turn;
            expect(live.currentPhase).toMatchObject({ stage: 'kb_search', detail: 'HR' });
            const ended = fold(adapter as FrameAdapter<ReturnType<typeof empty>>, live, [
                ['phase', { stage: 'kb_search', status: 'end', durationMs: 42 }],
            ]).turn;
            expect(ended.currentPhase).toBeNull();
            expect(ended.phaseTrail).toEqual([expect.objectContaining({ stage: 'kb_search', detail: 'HR', durationMs: 42 })]);
        }
    });

    it("an end of a stage the line no longer shows keeps the line but closes the trail's step", () => {
        const turn = fold(DIRECT_FRAMES, emptyStreamingTurn(), [
            ['phase', { stage: 'guardrails', status: 'start' }],
            ['phase', { stage: 'privacy_scan', status: 'start' }],
            ['phase', { stage: 'guardrails', status: 'end', durationMs: 60 }],
        ]).turn;
        expect(turn.currentPhase?.stage).toBe('privacy_scan');
        expect(turn.phaseTrail.map((r) => [r.stage, r.durationMs])).toEqual([['guardrails', 60], ['privacy_scan', null]]);
    });

    it('the first words settle the live line, and done clears it', () => {
        const turn = fold(AGENT_FRAMES, emptyAgentTurn(), [['phase', { stage: 'reading' }], ['content', { text: 'Hi' }]]).turn;
        expect(turn.currentPhase).toBeNull();
        const done = fold(AGENT_FRAMES, emptyAgentTurn(), [['phase', { stage: 'reading' }], ['done']]).turn;
        expect(done.currentPhase).toBeNull();
    });

    it('takes the conversation id mid-stream on direct chat, and at done on agents', () => {
        const direct = fold(DIRECT_FRAMES, emptyStreamingTurn(), [['conversation_created', { conversationId: 'c1' }]]);
        expect(direct.turn.conversationId).toBe('c1');
        const agent = fold(AGENT_FRAMES, emptyAgentTurn(), [['conversation_created', { conversationId: 'c1' }]]);
        expect(agent.unknown).toEqual(['conversation_created']);
        expect(fold(AGENT_FRAMES, emptyAgentTurn(), [['done', { conversationId: 'c2' }]]).turn.conversationId).toBe('c2');
    });
});

describe('tools', () => {
    it('matches a tool_end by id, else the first running call of that name, and times it', () => {
        const turn = fold(DIRECT_FRAMES, emptyStreamingTurn(), [
            ['tool_start', { id: 't1', name: 'web_search', label: 'Searching', args: { query: 'bees' } }],
            ['tool_end', { id: 't1', summary: 'Found 3' }],
            ['tool_start', { name: 'kb' }],
            ['tool_start', { name: 'kb' }],
            ['tool_end', { name: 'kb', error: 'boom', result: { error: 'boom' } }],
        ]).turn;
        expect(turn.tools).toEqual([
            expect.objectContaining({ id: 't1', name: 'web_search', status: 'done', detail: 'Found 3', args: { query: 'bees' } }),
            expect.objectContaining({ id: 'kb-1', name: 'kb', status: 'error', resultPreview: '{"error":"boom"}' }),
            expect.objectContaining({ id: 'kb-2', name: 'kb', status: 'running' }),
        ]);
        expect(turn.tools[0]?.startTime).toEqual(expect.any(Number));
        expect(turn.tools[0]?.endTime).toEqual(expect.any(Number));
    });

    it('names notebook tools by name alone and never marks them failed', () => {
        const turn = fold(libraryFrames(() => ({})), emptyLibraryTurn(), [
            ['tool_start', { id: 'ignored', name: 'research' }],
            ['tool_end', { name: 'research', error: 'x' }],
        ]).turn;
        expect(turn.tools).toEqual([{ id: 'research', name: 'research', status: 'done' }]);
    });
});

describe('refusals and questions', () => {
    it('holds a DLP question until it is resolved, on direct and agents', () => {
        const direct = fold(DIRECT_FRAMES, emptyStreamingTurn(), [['dlp_preview', { decisionId: 'd1' }]]).turn;
        expect(direct.dlpDecision).toEqual({
            decisionId: 'd1',
            summary: 'Bee Flow found personal data in what you are about to send.',
            kind: 'chat_text',
            findings: [],
        });
        expect(fold(DIRECT_FRAMES, direct, [['dlp_resolved']]).turn.dlpDecision).toBeNull();
        expect(fold(AGENT_FRAMES, emptyAgentTurn(), [['dlp_preview', { id: 'd2' }]]).turn.dlpDecision?.decisionId).toBe(
            'd2',
        );
    });

    it('takes the question down when the server stops waiting on it, on direct and agents', () => {
        for (const [adapter, empty] of [
            [DIRECT_FRAMES, emptyStreamingTurn],
            [AGENT_FRAMES, emptyAgentTurn],
        ] as const) {
            const { turn, marks } = fold(adapter as FrameAdapter<ReturnType<typeof empty>>, empty(), [
                ['dlp_preview', { decisionId: 'd1' }],
                ['dlp_blocked', { reason: 'timeout', findings: [] }],
            ]);
            expect(turn.dlpDecision).toBeNull();
            expect(turn.blocked).toEqual({
                reason: 'Data-loss prevention stopped this message.',
                detail: 'Blocked: DLP decision timed out.',
            });
            expect(marks).toEqual(['dlp_preview', 'dlp_blocked']);
        }
    });

    it('words the review’s own outcomes, and keeps any other reason as it came', () => {
        const refused = (data: object) => fold(DIRECT_FRAMES, emptyStreamingTurn(), [['dlp_blocked', data]]).turn.blocked;
        expect(refused({ reason: 'user_blocked' })?.detail).toBe('Prompt blocked by you.');
        expect(refused({ reason: 'pii_unavailable', message: 'x' })?.detail).toBe('pii_unavailable');
        expect(refused({})).toEqual({ reason: 'Data-loss prevention stopped this message.', detail: undefined });
    });

    it('ignores a DLP question with no id rather than showing one it cannot answer', () => {
        const { turn, marks } = fold(DIRECT_FRAMES, emptyStreamingTurn(), [['dlp_preview', { summary: 'x' }]]);
        expect(turn.dlpDecision).toBeNull();
        expect(marks).toEqual([]);
    });

    it('explains a guardrail with its reason, or on notebooks with the rules that fired', () => {
        const direct = fold(DIRECT_FRAMES, emptyStreamingTurn(), [['guardrail_blocked', { message: 'nope' }]]).turn;
        expect(direct.blocked).toEqual({ reason: 'A guardrail stopped this response.', detail: 'nope' });
        const notebook = fold(libraryFrames(() => ({})), emptyLibraryTurn(), [
            ['guardrail_violation', { rules: ['pii', 'tone'], reason: 'x' }],
        ]).turn;
        expect(notebook.blocked).toEqual({ reason: 'A guardrail stopped this response.', detail: 'pii, tone' });
    });

    it('ends the meeting turn with one privacy sentence for either refusal', () => {
        const turn = fold(MEETING_FRAMES, emptyMeetingTurn(), [['dlp_blocked', { reason: 'names' }]]).turn;
        expect(turn.error).toBe('That answer was stopped by your organisation’s privacy rules.');
        expect(fold(MEETING_FRAMES, emptyMeetingTurn(), [['guardrail_violation']]).unknown).toEqual([
            'guardrail_violation',
        ]);
    });

    it('locks a notebook whose history this session cannot open', () => {
        const turn = fold(libraryFrames(() => ({})), emptyLibraryTurn(), [['history_locked']]).turn;
        expect(turn.locked).toBe(true);
        expect(turn.blocked?.detail).toBe('Unlock encryption on this device to keep chatting here.');
    });

    it('says a direct chat is read-only on history_locked', () => {
        const turn = fold(DIRECT_FRAMES, emptyStreamingTurn(), [['history_locked']]).turn;
        expect(turn.blocked).toEqual({ reason: 'This conversation is read-only for you.' });
    });
});

describe('the end of a turn', () => {
    it("ends on the server's error with its message, or a stated fallback", () => {
        expect(fold(DIRECT_FRAMES, emptyStreamingTurn(), [['error', { error: 'Model down' }]]).turn).toMatchObject({
            error: 'Model down',
            done: true,
        });
        expect(fold(AGENT_FRAMES, emptyAgentTurn(), [['error']]).turn.error).toBe('The server reported an error.');
    });

    it('refuses a second answer in the same direct conversation', () => {
        expect(fold(DIRECT_FRAMES, emptyStreamingTurn(), [['turn_busy']]).turn.error).toBe(
            'Another answer is already running in this conversation.',
        );
    });
});

describe('the swarm', () => {
    it('shows workers, and takes the synthesis as the answer only when nothing else arrived', () => {
        const turn = fold(DIRECT_FRAMES, emptyStreamingTurn(), [
            ['swarm_started'],
            ['swarm_phase_started', { phase: 'research' }],
            ['swarm_worker_started', { workerId: 'w1', role: 'Analyst' }],
            ['swarm_worker_content', { workerId: 'w1', text: 'notes' }],
            ['swarm_worker_completed', { workerId: 'w1' }],
            ['swarm_completed', { result: 'Synthesis' }],
        ]).turn;
        expect(turn.swarm).toEqual({
            phase: 'research',
            workers: [{ id: 'w1', name: 'Analyst', status: 'done', text: 'notes' }],
            completed: true,
        });
        expect(turn.text).toBe('Synthesis');
    });

    it('ignores worker output that arrives before the swarm started, without a render', () => {
        const { turn, marks } = fold(DIRECT_FRAMES, emptyStreamingTurn(), [['swarm_worker_content', { text: 'x' }]]);
        expect(turn.swarm).toBeNull();
        expect(marks).toEqual([]);
    });

    it('is not an agent or notebook event', () => {
        expect(fold(AGENT_FRAMES, emptyAgentTurn(), [['swarm_started']]).unknown).toEqual(['swarm_started']);
    });
});

describe('the notebook-only frames', () => {
    it('hand document rewrites and new sources to the screen, without a render', () => {
        const onDocumentUpdate = jest.fn();
        const onSourceAdded = jest.fn();
        const adapter = libraryFrames(() => ({ onDocumentUpdate, onSourceAdded }));
        const { marks } = fold(adapter, emptyLibraryTurn(), [
            ['notebook_doc_update', { content: '<p>x</p>', title: 'T', version: 4 }],
            ['notebook_source_added', { source: { id: 's1' } }],
            ['notebook_source_added', { source: 'not a row' }],
        ]);
        expect(onDocumentUpdate).toHaveBeenCalledWith('<p>x</p>', 'T', 4);
        expect(onSourceAdded).toHaveBeenCalledTimes(1);
        expect(onSourceAdded).toHaveBeenCalledWith({ id: 's1' });
        expect(marks).toEqual([]);
    });

    it('reads the callbacks when a frame arrives, not when the adapter was built', () => {
        let current = jest.fn();
        const adapter = libraryFrames(() => ({ onDocumentUpdate: current }));
        const later = jest.fn();
        current = later;
        fold(adapter, emptyLibraryTurn(), [['notebook_doc_update', { content: 'x' }]]);
        expect(later).toHaveBeenCalledWith('x', undefined, undefined);
    });
});

describe('what each surface ignores on purpose', () => {
    it('ignores the heartbeat everywhere it can arrive, without a render or a report', () => {
        for (const adapter of [DIRECT_FRAMES, AGENT_FRAMES, libraryFrames(() => ({}))] as FrameAdapter<unknown>[]) {
            expect(accounts(adapter, 'ping')).toBe(true);
        }
        expect(fold(DIRECT_FRAMES, emptyStreamingTurn(), [['ping']])).toMatchObject({ marks: [], unknown: [] });
    });

    it("reports on one surface what only the other one's runtime emits", () => {
        expect(fold(DIRECT_FRAMES, emptyStreamingTurn(), [['tool_loop_broken']]).unknown).toEqual(['tool_loop_broken']);
        expect(fold(AGENT_FRAMES, emptyAgentTurn(), [['running', { label: 'x' }]]).unknown).toEqual(['running']);
    });
});
