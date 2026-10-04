/**
 * Every key the model BORROWS from the web exists in both English
 * dictionaries, and carries the English the model falls back to.
 *
 * The model builds most of its keys (`automations.node.<type>.<field>`), so the
 * i18n guard's source scan cannot see them; this test asks every accessor for
 * the key it would use and checks it against the server catalogue (which the
 * phone reads) and the client one (which the browser reads). A `mobile.*`
 * key is this package's own namespace and is exempt, as in the guard.
 */

import { CLIENT_DICT, SERVER_DICT, readDict } from '@/core/i18n/dictionaryText';

import { NODE_DEFS, NODE_TYPE_KEYS } from './nodeDefs';
import { buildStepGroups, codeItemFor, gated, PEOPLE_ITEMS } from './palette';
import type { PaletteGroup } from './palette';

const server = readDict(SERVER_DICT);
const client = readDict(CLIENT_DICT);

/** A `t` that records every key it is asked for, with its fallback. */
function recorder() {
    const asked = new Map<string, string>();
    const t = (key: string, fallback: string) => {
        asked.set(key, fallback);
        return fallback;
    };
    return { t, asked };
}

const unescape = (v: string | undefined) => v?.replace(/\\(['"\\])/g, '$1');

/**
 * Keys the WEB's own accessors ask for that its dictionaries do not answer
 * as nodeDefs.js words them — gaps on the web side, which the phone inherits
 * by asking for the same keys (the English fallback renders, on both). Listed
 * so the phone does not paper over them with keys of its own; a line goes
 * when the dictionaries catch up, and "no stale lines" below fails until it
 * does.
 */
const KNOWN_WEB_GAPS = new Map<string, string>([
    ['automations.node.data_extraction.help', 'not in the dictionaries yet'],
    ['automations.node.http_request.help', 'the dictionaries hold the shorter, older sentence'],
    ['automations.node.wait.help', 'the dictionaries hold the shorter, older sentence'],
    ...['typeLabel', 'defaultLabel', 'label', 'desc', 'help'].map((f): [string, string] => [`automations.node.note.${f}`, 'the note (BFSF-411) was never added to the dictionaries']),
    ...['loop_item', 'ai_tool', 'row_label', 'ghost_step'].flatMap((type) =>
        ['typeLabel', 'help'].map((f): [string, string] => [`automations.node.${type}.${f}`, 'a canvas-only node, never added to the dictionaries'])),
]);

const answered = (key: string, english: string) => unescape(server.get(key)) === english && client.has(key);

describe('borrowed keys', () => {
    const { t, asked } = recorder();
    const FIELDS = ['typeLabel', 'defaultLabel', 'help', 'label', 'desc'] as const;
    // What the node catalogue can be asked for…
    for (const type of NODE_TYPE_KEYS) {
        for (const field of FIELDS) {
            const english = NODE_DEFS[type]?.[field];
            if (english) t(`automations.node.${type}.${field}`, english);
        }
    }
    // …and what the picker asks for in every scope.
    const scopes = [{}, { inLayer: true, canAddLayerOutput: true }, { catalog: { steps: [{ id: 'b', title: 'B' }], flags: { codeReason: 'org' } } }];
    const groups: PaletteGroup[] = scopes.flatMap((scope) => buildStepGroups({ ...scope, t }));
    PEOPLE_ITEMS.forEach((it) => gated(it, false));
    codeItemFor({ flags: { codeReason: 'platform' } });

    const borrowed = [...asked].filter(([key]) => !key.startsWith('mobile.'));

    it('asks for real keys', () => {
        expect(groups.length).toBeGreaterThan(10);
        expect(borrowed.length).toBeGreaterThan(150);
    });

    it.each(borrowed.filter(([key]) => !KNOWN_WEB_GAPS.has(key)))('%s is in both dictionaries, with the same English', (key, english) => {
        expect({ key, server: unescape(server.get(key)) }).toEqual({ key, server: english });
        expect({ key, client: client.has(key) }).toEqual({ key, client: true });
    });

    it('no stale lines: every known gap is still asked for, and still a gap', () => {
        const stale = [...KNOWN_WEB_GAPS.keys()].filter((key) => !asked.has(key) || answered(key, asked.get(key) as string));
        expect(stale).toEqual([]);
    });
});
