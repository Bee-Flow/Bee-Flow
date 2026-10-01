/**
 * The trigger editor held to the web editor it ports (agent-hub
 * `Builder/flow/settings/triggerEditors.jsx`, `triggerFilters.jsx`,
 * `Builder/webhooks/useWebhooks.js`):
 *
 *   - TEXTUAL: the kinds the select offers (and which only a primary trigger
 *     may be), each kind's band title, the legacy provider names, and — per
 *     app event — which filter form it gets, the keys that form writes in the
 *     web's order, the words on each row and the form's title;
 *   - EVALUATED: the cURL command and the secret mask, cut out of the web's
 *     own source and run beside the port.
 * A failure means the web editor changed: update the port, don't loosen this.
 */

import fs from 'node:fs';
import path from 'node:path';

import { LEGACY_PROVIDER_LABELS } from './appEvent';
import { FILTER_FORMS } from './filters';
import { kindTitle, TRIGGER_KINDS } from './kinds';
import { buildCurlSnippet, maskSecret } from './webhook';
import type { Msg } from '../declarative/spec';

const BUILDER = path.resolve(__dirname, '../../../../../../../agent-hub/src/components/automation/Builder');
const read = (rel: string) => fs.readFileSync(path.join(BUILDER, rel), 'utf8');
const editors = read('flow/settings/triggerEditors.jsx');
const filters = read('flow/settings/triggerFilters.jsx');

/** One function's source: from `function Name(` to the next top-level declaration. */
function fnSource(src: string, name: string): string {
    const start = src.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`${name} is gone`);
    const rest = src.slice(start + 1);
    const end = rest.search(/\n(?:export |function |const [A-Z_]+ = |\/\/ )/);
    return src.slice(start, end < 0 ? undefined : start + 1 + end);
}

describe('the trigger kinds', () => {
    const select = editors.slice(editors.indexOf('<select'), editors.indexOf('</select>'));
    const options = [...select.matchAll(/(\{!isSecondaryTrigger && )?<option value="([a-z_]+)">([^<]+)<\/option>/g)].map((m) => ({
        value: m[2],
        label: (m[3] as string).trim(),
        primaryOnly: !!m[1],
    }));

    it('offers the web’s kinds, in its order, with its words', () => {
        expect(options.length).toBe(7);
        expect(TRIGGER_KINDS.map((k) => ({ value: k.value, label: k.label[1], primaryOnly: k.primaryOnly }))).toEqual(options);
    });

    it('names each kind’s band as the web does', () => {
        const titles = /const kindTitle = ([\s\S]*?);\n/.exec(editors)?.[1] ?? '';
        const pairs = [...titles.matchAll(/kind === '([a-z_]+)' \? '([^']+)'/g)].map((m) => [m[1], m[2]]);
        const fallback = /: '([^']+)'\s*$/.exec(titles.trim())?.[1];
        expect(pairs.length).toBe(5);
        for (const [kind, title] of pairs) expect(kindTitle(kind as string)[1]).toBe(title);
        expect(kindTitle('app_event')[1]).toBe(fallback);
    });

    it('knows the web’s legacy provider names', () => {
        const block = /const LEGACY_PROVIDER_LABELS = \{([\s\S]*?)\};/.exec(editors)?.[1] ?? '';
        const web = Object.fromEntries([...block.matchAll(/'([^']+)': '([^']+)'/g)].map((m) => [m[1], m[2]]));
        expect(LEGACY_PROVIDER_LABELS).toEqual(web);
    });
});

describe('the app-event filters', () => {
    const map = /export const FILTER_FORM_BY_KEY = \{([\s\S]*?)\};/.exec(filters)?.[1] ?? '';
    const webMap = [...map.matchAll(/'([^']+)': (\w+),/g)].map((m) => [m[1] as string, m[2] as string] as [string, string]);

    it('maps the same events, in the same order', () => {
        expect(webMap.length).toBe(22);
        expect(Object.keys(FILTER_FORMS)).toEqual(webMap.map(([k]) => k));
    });

    it('gives events that share a web form the same form', () => {
        const byFn = new Map<string, string[]>();
        for (const [key, fn] of webMap) byFn.set(fn, [...(byFn.get(fn) ?? []), key]);
        for (const keys of byFn.values()) {
            const forms = new Set(keys.map((k) => FILTER_FORMS[k]));
            expect(forms.size).toBe(1);
        }
        expect(byFn.size).toBe(16);
    });

    it.each(webMap.filter(([, fn], i) => webMap.findIndex(([, f]) => f === fn) === i))('%s writes the web’s keys in the web’s order', (key, fn) => {
        const src = fnSource(filters, fn);
        const webKeys = [...new Set([...src.matchAll(/setFilter\('(\w+)'/g)].map((m) => m[1]))];
        const ours = (FILTER_FORMS[key]?.fields ?? []).filter((f) => f.kind !== 'note').map((f) => f.id);
        expect(ours).toEqual(webKeys);
    });

    it.each(webMap.filter(([, fn], i) => fn !== 'MeetingNotesProcessedFilterFields' && webMap.findIndex(([, f]) => f === fn) === i))(
        '%s labels its rows and titles itself in the web’s words',
        (key, fn) => {
            const src = fnSource(filters, fn);
            const webLabels = [...src.matchAll(/<FormRow label="([^"]+)"/g)].map((m) => m[1]);
            const form = FILTER_FORMS[key];
            const labels = (form?.fields ?? []).filter((f) => f.kind !== 'note').map((f) => (f.label as Msg)[1]);
            // The phone's list replaces the web's "(comma-separated)" box.
            expect(labels).toEqual(webLabels.map((l) => (l as string).replace(' (comma-separated)', '')));
            const title = /FilterShell title="([^"]+)"/.exec(src)?.[1] ?? /sectionHeaderClass\(\)}>([^<]+)</.exec(src)?.[1];
            expect(form?.title[1]).toBe(title);
        },
    );
});

describe('the webhook panel, evaluated from the web’s source', () => {
    const src = read('webhooks/useWebhooks.js');
    const cut = (name: string) => {
        const at = src.indexOf(`export function ${name}(`);
        return src.slice(at, src.indexOf('\n}\n', at) + 2).replace('export function', 'function');
    };
    const web = <T>(name: string): T => new Function(`${cut(name)}\nreturn ${name};`)() as T;

    it('builds the same signed cURL command', () => {
        const webCurl = web<(url: string, secret: string) => string>('buildCurlSnippet');
        expect(buildCurlSnippet('https://h.example/api/automation/webhook/abc', 'k3y')).toBe(webCurl('https://h.example/api/automation/webhook/abc', 'k3y'));
    });

    it.each(['', 'short', '12345678', 'abcdefghijklmnop'])('masks %j the same way', (secret) => {
        expect(maskSecret(secret)).toBe(web<(s: string) => string>('maskSecret')(secret));
    });
});
