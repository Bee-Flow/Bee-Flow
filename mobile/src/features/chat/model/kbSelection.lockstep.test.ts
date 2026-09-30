/**
 * TEXTUAL lockstep: why a knowledge-base change did not save, against the
 * web's conversationKbApi.js and KnowledgeBasePanel.jsx.
 */

import fs from 'node:fs';

import { ApiError } from '@/core/api/client';
import { AGENT_HUB_SRC } from '@/shared/testing/webModule';

import { KB_REFUSAL_WORDS, kbRefusalOf, MAX_ATTACHED_KBS, sameSelection } from './kbSelection';

const API = fs.readFileSync(`${AGENT_HUB_SRC}/components/chat/conversationKbApi.js`, 'utf8');
const PANEL = fs.readFileSync(`${AGENT_HUB_SRC}/components/chat/InputArea/KnowledgeBasePanel.jsx`, 'utf8');
const CLAIM = fs.readFileSync(`${AGENT_HUB_SRC}/components/chat/knowledgeBaseClaim.js`, 'utf8');

const refused = (status: number, body?: unknown) => Object.assign(new ApiError('x'), { status, body });

it('reads a refusal by status as the web does', () => {
    expect(API).toContain("const STATUS_REASONS = { 403: 'forbidden', 404: 'gone', 503: 'unavailable' };");
    expect(kbRefusalOf(refused(403))).toBe('forbidden');
    expect(kbRefusalOf(refused(404))).toBe('gone');
    expect(kbRefusalOf(refused(503))).toBe('unavailable');
    expect(kbRefusalOf(refused(400, { invalid: ['kb9'] }))).toBe('invalid');
    expect(kbRefusalOf(refused(400, {}))).toBe('rejected');
    expect(kbRefusalOf(refused(500))).toBe('failed');
    expect(kbRefusalOf(new Error('offline'))).toBe('failed');
});

it("says why in the panel's words, and caps a chat where the web does", () => {
    for (const reason of ['invalid', 'too_many', 'forbidden', 'gone', 'unavailable', 'failed'] as const) {
        const { i18nKey, en } = KB_REFUSAL_WORDS[reason];
        expect(PANEL).toContain(`t('${i18nKey}', '${en}'`);
    }
    expect(CLAIM).toContain(`export const MAX_ATTACHED_KBS = ${MAX_ATTACHED_KBS};`);
});

it('compares selections without regard to order', () => {
    expect(sameSelection(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameSelection(['a'], ['a', 'b'])).toBe(false);
});
