/**
 * What the phone does with a frame it was not built for.
 *
 * The reducer's dangerous outcome is not a crash — it is silence. An event the
 * server started sending and this file never learned falls to `default:
 * onUnhandled`, which no screen renders, so the turn looks finished and
 * something the person asked for simply did not happen. `tool_confirm` sat in
 * that hole from the A-track onwards.
 *
 * These tests drive `applyStreamEvent` directly rather than mounting the hook:
 * the question is which frames are ACCOUNTED FOR, and a rendered component
 * answers that question only for the frames that happen to draw something.
 */

import { applyStreamEvent, type AgentTurn } from './useAgentChatStream';

/** A turn as `send` starts one. Rebuilt per test — the reducer mutates it. */
function freshTurn(): AgentTurn {
    return {
        text: '',
        thinking: '',
        thinkingActive: false,
        phase: null,
        tools: [],
        sources: [],
        images: [],
        blocked: null,
        dlpDecision: null,
        conversationId: null,
        title: null,
        error: null,
        accessDenied: false,
        done: false,
    };
}

/** The payload server/core/agentRuntime/toolRoundExecutor.js actually sends. */
const TOOL_CONFIRM = {
    callId: 'toolu_01abc',
    toolName: 'send_email',
    effect: 'write',
    preview: 'to: finance@example.com',
    argsKey: 'a1b2c3',
    status: 'pending',
};

describe('applyStreamEvent', () => {
    it('accounts for tool_confirm instead of dropping it as unknown', () => {
        // The event is ignored on purpose (there is no reply channel on this
        // route yet — see the comment on the case), but "ignored" and
        // "unrecognised" are different states, and only one of them is a
        // decision somebody made.
        const turn = freshTurn();
        const onUnhandled = jest.fn();
        const mark = jest.fn();

        applyStreamEvent(turn, 'tool_confirm', TOOL_CONFIRM, mark, onUnhandled);

        expect(onUnhandled).not.toHaveBeenCalled();
    });

    it('leaves the turn exactly as it was, and does not force a render', () => {
        // Ignoring has to be free. A frame that marks the turn dirty without
        // changing anything costs a re-render per held tool call, and one that
        // touched `done` or `error` would end the turn early.
        const turn = freshTurn();
        const mark = jest.fn();

        applyStreamEvent(turn, 'tool_confirm', TOOL_CONFIRM, mark, jest.fn());

        expect(turn).toEqual(freshTurn());
        expect(mark).not.toHaveBeenCalled();
    });

    it('still reports an event nobody has decided about', () => {
        // The other half: this is only a real guard while an unknown name DOES
        // reach onUnhandled. Widen the ignore list to a catch-all and the test
        // above passes on everything, forever.
        const onUnhandled = jest.fn();

        applyStreamEvent(freshTurn(), 'some_event_from_next_year', { a: 1 }, jest.fn(), onUnhandled);

        expect(onUnhandled).toHaveBeenCalledWith('some_event_from_next_year', { a: 1 });
    });

    it('survives a tool_confirm with no payload at all', () => {
        // A frame whose `data` failed to parse arrives as null. Nothing here
        // reads the payload, and nothing may start.
        const turn = freshTurn();
        expect(() => applyStreamEvent(turn, 'tool_confirm', null, jest.fn(), jest.fn())).not.toThrow();
        expect(turn.error).toBeNull();
    });
});
