/**
 * The two decisions behind "Try again" on a failed chat answer.
 */

import fs from 'node:fs';

import { AGENT_HUB_SRC } from '@/shared/testing/webModule';

import { promptFor, retryTiers, RETRY_TIER_KEYS, unsavedFailure } from './retry';
import type { ChatMessage } from './types';

const user = (id: string, content: string): ChatMessage => ({ id, role: 'user', content });
const answer = (id: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
    id,
    role: 'assistant',
    content: '',
    ...extra,
});

describe('promptFor', () => {
    it('finds the question a failed answer replied to', () => {
        const transcript = [user('u1', 'first'), answer('a1'), user('u2', 'second'), answer('a2', { error: 'boom' })];
        expect(promptFor(transcript, 'a2')?.content).toBe('second');
    });

    it('skips anything between the question and the answer', () => {
        const transcript = [user('u1', 'first'), { id: 't1', role: 'tool' as const, content: '' }, answer('a1', { error: 'x' })];
        expect(promptFor(transcript, 'a1')?.id).toBe('u1');
    });

    it('answers null when there is no question before it, or no such message', () => {
        expect(promptFor([answer('a1', { error: 'x' })], 'a1')).toBeNull();
        expect(promptFor([user('u1', 'q')], 'missing')).toBeNull();
    });
});

describe('unsavedFailure', () => {
    it('drops every local message once the server has the turn', () => {
        expect(unsavedFailure([user('l1', 'q'), answer('l2', { content: 'ok' })], [user('s1', 'q')])).toEqual([]);
    });

    it('keeps a failed last turn the server never saved, so its error stays on screen', () => {
        const local = [user('l1', 'new question'), answer('l2', { error: 'The connection was lost.' })];
        expect(unsavedFailure(local, [user('s1', 'older question'), answer('s2')])).toEqual(local);
    });

    it('keeps only the error when the server saved the question itself (an interrupted turn)', () => {
        const local = [user('l1', 'send the invoice'), answer('l2', { error: 'API error' })];
        const saved = [user('s1', 'send the invoice'), answer('s2', { interrupted: true })];
        expect(unsavedFailure(local, saved)).toEqual([local[1]]);
    });

    it('keeps the question when the same words were asked, and answered, before', () => {
        // The second "continue" failed before anything ran, so the server saved
        // nothing: the saved "continue" is the first one, with its answer.
        const local = [user('l1', 'continue'), answer('l2', { error: 'The connection was lost.' })];
        const saved = [user('s1', 'continue'), answer('s2', { content: 'Here is more.' })];
        expect(unsavedFailure(local, saved)).toEqual(local);
    });

    it('keeps the question when an older turn was the interrupted one', () => {
        const local = [user('l1', 'continue'), answer('l2', { error: 'x' })];
        const saved = [user('s1', 'continue'), answer('s2', { interrupted: true }), user('s3', 'other'), answer('s4')];
        expect(unsavedFailure(local, saved)).toEqual(local);
    });

    it('lets go of a failure once a later turn has gone through', () => {
        const local = [user('l1', 'q1'), answer('l2', { error: 'x' }), user('l3', 'q2'), answer('l4', { content: 'ok' })];
        expect(unsavedFailure(local, [])).toEqual([]);
    });
});

describe('unsavedFailure, for a turn the person stopped', () => {
    const EARLIER = [user('s1', 'yes'), answer('s2', { content: 'Shall I go on?' })];
    const asked = (content: string, sentAfter: string | null): ChatMessage => ({ ...user('l1', content), sentAfter });
    const half = answer('l2', { content: 'The first half', interrupted: true });

    it('keeps the question and the words that arrived while the server has neither', () => {
        const local = [asked('Summarise the report', 's2'), half];
        expect(unsavedFailure(local, EARLIER)).toEqual(local);
    });

    it('keeps a stop that arrived with no words at all', () => {
        const local = [asked('Summarise the report', null), answer('l2', { interrupted: true })];
        expect(unsavedFailure(local, [])).toEqual(local);
    });

    it("gives way to the server's copy once it has the turn — the whole answer, when the provider finished it", () => {
        const local = [asked('Summarise the report', 's2'), half];
        const saved = [...EARLIER, user('s3', 'Summarise the report'), answer('s4', { content: 'The first half, and the rest.' })];
        expect(unsavedFailure(local, saved)).toEqual([]);
    });

    it('does not take an earlier question with the same words for this one', () => {
        // "yes" again, stopped: the saved "yes" is the one asked before it.
        const local = [asked('yes', 's2'), half];
        expect(unsavedFailure(local, EARLIER)).toEqual(local);
        expect(unsavedFailure(local, [...EARLIER, user('s3', 'yes'), answer('s4', { content: 'Going on.' })])).toEqual([]);
    });

    it('lets go of it once a later turn has gone through', () => {
        const local = [asked('q1', 's2'), half, user('l3', 'q2'), answer('l4', { content: 'ok' })];
        expect(unsavedFailure(local, EARLIER)).toEqual([]);
    });

    it('lets a stopped edit of saved messages go: the server kept them, and they come back in place', () => {
        const local = [{ ...asked('yes, but shorter', null), replaces: true }, half];
        expect(unsavedFailure(local, EARLIER)).toEqual([]);
    });

    it('still keeps a failed edit, whose error has its own card', () => {
        const local = [{ ...asked('yes, but shorter', null), replaces: true }, answer('l2', { error: 'The connection was lost.' })];
        expect(unsavedFailure(local, EARLIER)).toEqual(local);
    });
});

describe('the tiers a retry offers', () => {
    it("matches the web's list, in its order", () => {
        const src = fs.readFileSync(`${AGENT_HUB_SRC}/components/chat/MessageItem/MessageActionsRow.jsx`, 'utf8');
        const web = /RETRY_KEYS = \[([^\]]+)\]/.exec(src)?.[1]?.match(/'([^']+)'/g)?.map((k) => k.slice(1, -1));
        expect([...RETRY_TIER_KEYS]).toEqual(web);
    });

    it('offers Auto always and the others only with a model', () => {
        expect(retryTiers({ fast: { modelId: 'm' }, writer: {}, pro: { modelId: 'p' } })).toEqual(['auto', 'fast', 'pro']);
    });
});
