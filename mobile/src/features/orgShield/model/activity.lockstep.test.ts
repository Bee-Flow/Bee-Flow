/**
 * Health (GDPR Art. 9) is an organisation total only, on the server, the web
 * and the phone. The three must agree on WHICH stored categories are health:
 * a spelling the server strips but a client does not know is a health label
 * that a client could still offer as a filter. The server's own tables are
 * the source (core/privacy/personalColumns.js maps a category to the kind
 * 'health'; core/privacy/specialCategories.js says which kinds are special).
 * When this fails, the server changed: port it to the phone and the web.
 */

import fs from 'node:fs';
import path from 'node:path';

import { SERVER_DICT, readDict } from '@/core/i18n/dictionaryText';

import { SPECIAL_CATEGORY_SPELLINGS, SPECIAL_TOTAL_NOTE } from './activity';

const REPO = path.resolve(__dirname, '../../../../..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const squash = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The keys of one `const NAME = Object.freeze({ ... });` table that map to `kind`. */
function keysOfKind(source: string, table: string, kind: string): string[] {
    const body = new RegExp(`const ${table} = Object\\.freeze\\(\\{([\\s\\S]*?)\\}\\);`).exec(source)?.[1] ?? '';
    return [...body.matchAll(new RegExp(`(\\w+):\\s*'${kind}'`, 'g'))].map((m) => m[1] ?? '');
}

/** The quoted strings inside `<name> ... Object.freeze([ ... ])`. */
function frozenList(source: string, name: string): string[] {
    const body = new RegExp(`${name}[^=]*=\\s*Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\)`).exec(source)?.[1] ?? '';
    return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
}

const sorted = (list: readonly string[]) => [...new Set(list)].sort();

describe('special categories (GDPR Art. 9)', () => {
    const columns = read('server/core/privacy/personalColumns.js');

    it('health is the one special kind on the server', () => {
        expect(frozenList(read('server/core/privacy/specialCategories.js'), 'const SPECIAL_KINDS')).toEqual(['health']);
    });

    it('the phone knows every spelling the server reads as health', () => {
        const server = [...keysOfKind(columns, 'KIND_OF_CATEGORY', 'health'), ...keysOfKind(columns, 'LOOSE_KIND', 'health')];
        expect(server.length).toBeGreaterThanOrEqual(5);
        expect(sorted(SPECIAL_CATEGORY_SPELLINGS)).toEqual(sorted(server.map(squash)));
    });

    it('the web keeps the same list', () => {
        const web = read('agent-hub/src/components/admin/security/guardrails/orgShield/activity/specialCategories.ts');
        expect(sorted(frozenList(web, 'export const SPECIAL_CATEGORY_SPELLINGS'))).toEqual(sorted(SPECIAL_CATEGORY_SPELLINGS));
    });

    it('the note is in the dictionary with the same English', () => {
        expect(readDict(SERVER_DICT).get(SPECIAL_TOTAL_NOTE.key)).toBe(SPECIAL_TOTAL_NOTE.en);
    });
});
