/**
 * What the phone does with a frame it was not built for — and with the one it
 * used to drop.
 *
 * The reducer's dangerous outcome is not a crash — it is silence. An event the
 * server started sending and this file never learned falls to `onUnhandled`,
 * which no screen renders, so the turn looks finished and something the person
 * asked for simply did not happen. `tool_confirm` sat in that hole from the
 * A-track onwards; it now lands on the turn as a held call the transcript
 * draws as a card.
 */

import { AGENT_FRAMES, emptyAgentTurn, type AgentTurn } from './agent';
import { reduceFrame } from '../chatFrameReducer';

/** One frame through the agent surface, the way the stream folds it. */
function applyStreamEvent(
    turn: AgentTurn,
    event: string,
    data: unknown,
    mark: () => void,
    onUnhandled: (event: string, data: unknown) => void,
): void {
    reduceFrame(AGENT_FRAMES, turn, { event, data }, { mark, onUnhandled });
}

/** The payload server/core/agentRuntime/toolRoundExecutor.js actually sends. */
const TOOL_CONFIRM = {
    callId: 'toolu_01abc',
    toolName: 'send_email',
    effect: 'sends',
    preview: { to: 'finance@example.com' },
    argsKey: 'a1b2c3',
    status: 'pending',
};

describe('tool_confirm on an agent turn', () => {
    it('lands as a held call, and says so with a render', () => {
        const turn = emptyAgentTurn();
        const onUnhandled = jest.fn();
        const mark = jest.fn();

        applyStreamEvent(turn, 'tool_confirm', TOOL_CONFIRM, mark, onUnhandled);

        expect(onUnhandled).not.toHaveBeenCalled();
        expect(mark).toHaveBeenCalled();
        expect(turn.pendingToolCalls).toEqual([
            { callId: 'toolu_01abc', argsKey: 'a1b2c3', toolName: 'send_email', effect: 'sends', preview: { to: 'finance@example.com' }, status: 'pending' },
        ]);
    });

    it('updates the same action in place when the server reports its outcome', () => {
        // Keyed on argsKey — name plus arguments — so a later `approved` for
        // this very call is this card, not a second one.
        const turn = emptyAgentTurn();
        applyStreamEvent(turn, 'tool_confirm', TOOL_CONFIRM, jest.fn(), jest.fn());
        applyStreamEvent(turn, 'tool_confirm', { ...TOOL_CONFIRM, callId: 'toolu_02', status: 'approved' }, jest.fn(), jest.fn());
        expect(turn.pendingToolCalls).toHaveLength(1);
        expect(turn.pendingToolCalls[0]).toMatchObject({ callId: 'toolu_02', status: 'approved' });
    });

    it('ignores a card with nothing to key it on, without a render', () => {
        const turn = emptyAgentTurn();
        const mark = jest.fn();
        applyStreamEvent(turn, 'tool_confirm', null, mark, jest.fn());
        applyStreamEvent(turn, 'tool_confirm', { toolName: 'x' }, mark, jest.fn());
        expect(turn).toEqual(emptyAgentTurn());
        expect(mark).not.toHaveBeenCalled();
    });
});

describe('an event nobody has decided about', () => {
    it('still reaches onUnhandled', () => {
        // Only a real guard while an unknown name DOES reach onUnhandled.
        // Widen the table to a catch-all and every test above passes forever.
        const onUnhandled = jest.fn();

        applyStreamEvent(emptyAgentTurn(), 'some_event_from_next_year', { a: 1 }, jest.fn(), onUnhandled);

        expect(onUnhandled).toHaveBeenCalledWith('some_event_from_next_year', { a: 1 });
    });
});
