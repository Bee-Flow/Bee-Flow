import { describe, expect, it } from 'vitest';

import { createContentFlusher } from './contentFlusher';
import { dispatchSSEEvent } from './sseEvents';
import type { ChatMessage, SseDispatchContext, SseDispatchIds, SseEventData } from './types';
import EN_DEFAULTS from '../../i18n/en-defaults';
import { interpolate } from '../useTranslation';
import type { TranslateFn } from '../useTranslation';

/**
 * BFSF-349: a turn fails AFTER one of its tools already did something.
 *
 * The model files a ticket (the tool returns the new issue), then the next
 * model round fails with a provider 400. The ticket exists. Before this fix the
 * `error` event replaced the whole message with the bare error, labelled
 * "Failed to send", so the user retried and filed the ticket twice. Now the
 * reply so far stays, the completed actions are named before the error, and
 * the message carries how many ran so the label can say so.
 */

const ID = 'assistant-1';
const ERR = 'Chat error: API error 400: invalid_request_error';

const t: TranslateFn = (key, fallbackOrParams, paramsArg) => {
    const hasStringFallback = typeof fallbackOrParams === 'string';
    const params = hasStringFallback ? paramsArg : fallbackOrParams;
    const value = (EN_DEFAULTS as Record<string, unknown>)[key];
    const text = typeof value === 'string' ? value : (hasStringFallback ? fallbackOrParams : key);
    return interpolate(text, params);
};

function harness() {
    let messages: ChatMessage[] = [{ id: ID, role: 'assistant', content: '', isStreaming: true }];
    const setMessages = (fn: unknown) => {
        messages = (fn as (prev: ChatMessage[]) => ChatMessage[])(messages);
    };
    const activeIdRef = { current: ID };
    const contentRef = { current: '' };
    const ctx = {
        setMessages,
        tRef: { current: t },
        onGammaPreviewRef: { current: undefined },
    } as unknown as SseDispatchContext;
    const ids = {
        assistantMsgId: ID,
        userMsgId: 'user-1',
        activeIdRef,
        contentRef,
        flusher: createContentFlusher(setMessages as SseDispatchContext['setMessages'], activeIdRef, contentRef),
        workRef: { current: null },
    } as SseDispatchIds;
    return {
        send: (event: string, data: SseEventData) => dispatchSSEEvent(ctx, event, data, ids),
        get msg() { return messages[0]; },
    };
}

describe('error after a tool already succeeded', () => {
    it('keeps the reply so far, names the completed action and flags the message', () => {
        const h = harness();
        h.send('content', { text: 'Filing the ticket now.' });
        h.send('tool_start', { name: 'create_issue', args: { summary: 'Sample defect' } });
        h.send('tool_end', { name: 'create_issue', result: { id: 'ISSUE-1', created: true } });
        h.send('error', { error: ERR });

        const m = h.msg;
        expect(m.isError).toBe(true);
        expect(m.isStreaming).toBe(false);
        expect(m.completedToolCount).toBe(1);
        expect(m.errorDetail).toBe(ERR);
        const content = String(m.content);
        expect(content.startsWith('Filing the ticket now.')).toBe(true);
        expect(content).toMatch(/Done before the error: Create Issue\./);
        expect(content.endsWith(ERR)).toBe(true);
        // The tool rows themselves stay on the message for the activity card.
        expect(m.toolHistory?.[0]).toMatchObject({ name: 'create_issue', status: 'done' });
        expect(m.toolResults?.[0]).toMatchObject({ name: 'create_issue' });
    });

    it('counts repeats once in the label list, but every call in the count', () => {
        const h = harness();
        for (let i = 0; i < 2; i += 1) {
            h.send('tool_start', { name: 'create_issue', args: {} });
            h.send('tool_end', { name: 'create_issue', result: { id: `ISSUE-${i}` } });
        }
        h.send('error', { error: ERR });
        expect(h.msg.completedToolCount).toBe(2);
        expect(String(h.msg.content)).toMatch(/Done before the error: Create Issue ×2\./);
    });

    it('does not credit a tool whose result was an error', () => {
        const h = harness();
        h.send('tool_start', { name: 'create_issue', args: {} });
        h.send('tool_end', { name: 'create_issue', result: { error: 'Permission denied' } });
        h.send('error', { error: ERR });
        expect(h.msg.completedToolCount).toBeUndefined();
        expect(h.msg.errorDetail).toBeUndefined();
        expect(h.msg.content).toBe(ERR);
    });

    // The server reports a call that never ran as an ordinary result, one the
    // activity card does not read as a failure. Saying it "did happen" would
    // be the opposite mistake of the one this fixes.
    it.each([
        ['held for the user\'s approval', 'Waiting for the user to approve \'create_issue\'. It has not run. Tell the user what you are about to do and stop.'],
        ['still held', 'Still waiting for the user to approve \'create_issue\'. It has not run, and asking again will not run it.'],
        ['declined by the user', 'The user declined \'create_issue\'. It has not run and must not be attempted again this turn.'],
        ['refused before dispatch', '[Tool \'create_issue\' was not called: its arguments contained an email address, which org policy forbids.]'],
        ['a tool that threw', '[Tool \'create_issue\' failed: upstream timeout]'],
        ['a draft awaiting approval', { _action: 'email_draft', draft: { subject: 'Sample' }, message: 'Email draft prepared. Waiting for user approval to send.' }],
    ])('does not credit a call that never happened: %s', (_label, result) => {
        const h = harness();
        h.send('tool_start', { name: 'create_issue', args: {} });
        h.send('tool_end', { name: 'create_issue', result });
        h.send('error', { error: ERR });
        expect(h.msg.completedToolCount).toBeUndefined();
        expect(h.msg.content).toBe(ERR);
    });

    it('credits a tool whose output was redacted: it did run', () => {
        const h = harness();
        h.send('tool_start', { name: 'create_issue', args: {} });
        h.send('tool_end', { name: 'create_issue', result: '[Tool output redacted - contains Sample content]' });
        h.send('error', { error: ERR });
        expect(h.msg.completedToolCount).toBe(1);
    });

    it('does not credit a tool that was still running when the turn failed', () => {
        const h = harness();
        h.send('tool_start', { name: 'create_issue', args: {} });
        h.send('error', { error: ERR });
        expect(h.msg.completedToolCount).toBeUndefined();
        expect(h.msg.content).toBe(ERR);
    });

    it('leaves a turn without tools as it was: the bare error', () => {
        const h = harness();
        h.send('content', { text: 'Partial answer' });
        h.send('error', { error: ERR });
        expect(h.msg.isError).toBe(true);
        expect(h.msg.completedToolCount).toBeUndefined();
        expect(h.msg.content).toBe(ERR);
    });
});
