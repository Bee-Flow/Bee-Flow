/**
 * TEXTUAL lockstep: the error headings against the web's own chain in
 * MessageContentBody.jsx — the same keys and English in the same order, and
 * the same words tested — plus a run over the sentences the server sends.
 */

import fs from 'node:fs';

import { AGENT_HUB_SRC } from '@/shared/testing/webModule';

import { ERROR_TITLES, errorKindOf, LIMIT_WORDS } from './errorKind';

const SRC = fs.readFileSync(`${AGENT_HUB_SRC}/components/chat/MessageItem/MessageContentBody.jsx`, 'utf8');
// The web tests `cardText`: the error alone, without the reply a turn that
// failed after some of its tools ran keeps above it (BFSF-349). The phone's
// `error` is already only that.
const chain = SRC.slice(SRC.indexOf('const errorTitle'), SRC.indexOf('const errorCard'));

describe('the error headings match the web', () => {
    it('in keys, English and order', () => {
        const web = [...chain.matchAll(/\{ key: '([^']+)', en: '([^']+)' \}/g)].map((m) => ({ key: m[1], en: m[2] }));
        expect(ERROR_TITLES.map(({ key, en }) => ({ key, en }))).toEqual(web);
    });

    it("renders each under this app's own name for the web's key", () => {
        for (const title of ERROR_TITLES) expect(title.i18nKey).toBe(title.key.replace('chat.msg.', 'mobile.chat.'));
    });

    it('in the words each heading tests, in order', () => {
        const web = [...chain.matchAll(/cardText\.includes\('([^']+)'\)/g)].map((m) => m[1]);
        const mine = ERROR_TITLES.flatMap((t) => [...t.all, ...(t.any ?? [])]);
        expect(mine).toEqual(web);
    });

    it('in the words that make it a limit', () => {
        const toneLine = SRC.slice(SRC.indexOf("cardText.includes('limit') || cardText.includes('subscription') || cardText.includes('suspended')"));
        const web = [...toneLine.slice(0, toneLine.indexOf('?')).matchAll(/cardText\.includes\('([^']+)'\)/g)].map((m) => m[1]);
        expect([...LIMIT_WORDS]).toEqual(web);
    });

    it.each([
        ['Your subscription is suspended.', 'chat.msg.err_sub_suspended', true],
        ['Monthly message limit reached (500).', 'chat.msg.err_message_limit', true],
        ['Your monthly Chat message limit is reached', 'chat.msg.err_message_limit', true],
        ['Chat error: 400 {"type":"invalid_request_error"}', 'chat.msg.err_generic', false],
        ['You hit the rate limit', 'chat.msg.err_sub_limit', true],
        ['The connection to the server was lost.', 'chat.msg.err_generic', false],
    ])('%s', (text, key, limit) => {
        expect(errorKindOf(text)).toMatchObject({ key, limit });
    });
});
