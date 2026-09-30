/**
 * The HTTP request editor held to the web's (actionEditors/httpRequestFields.jsx,
 * cacheIntoRow.jsx): its methods, the sentences its two "don't call twice"
 * ticks carry in each state, the header edits, the answers-table rules, and
 * the credential kinds' names (utils/httpCredentialTypes.js). Then what an
 * edit saves, through formState.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { CatalogDatatable } from '@/features/flow-editor/api';
import type { FlowNode } from '@/features/flow-editor/bindings';
import { buildPatch, extractFormState } from '@/features/flow-editor/formState';

import { addHeader, answerTables, cacheDays, cacheForDays, cacheTable, HTTP_KIND_NAMES, HTTP_METHODS, removeHeader, renameHeader, reuseAvailability, TABLE_AUDIENCE } from './httpModel';
import type { Msg } from '../declarative/spec';

const AGENT_HUB = path.resolve(__dirname, '../../../../../../../agent-hub/src');
const SETTINGS = path.join(AGENT_HUB, 'components/automation/Builder/flow/settings');
const src = fs.readFileSync(path.join(SETTINGS, 'actionEditors/httpRequestFields.jsx'), 'utf8');
const cacheSrc = fs.readFileSync(path.join(SETTINGS, 'actionEditors/cacheIntoRow.jsx'), 'utf8');
/* eslint-disable-next-line @typescript-eslint/no-require-imports */
const kinds = require(path.join(AGENT_HUB, 'utils/httpCredentialTypes.js'));

const english = (m: Msg | null): string | null => {
    if (!m) return null;
    let out = m[1];
    for (const [k, v] of Object.entries(m[2] ?? {})) out = out.split(`{${k}}`).join(String(v));
    return out;
};

/** The web's own availability block, cut out and run with a draft. */
const webAvailability = new Function(
    'draft',
    `const HTTP_WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
     const method = (draft.method || 'GET').toUpperCase();
     const blockPrivateTargets = draft.blockPrivateTargets !== false;
     ${src.slice(src.indexOf('const writeCaution'), src.indexOf('const renameHeader'))}
     return { askOnce, cacheInto };`,
) as (draft: Record<string, unknown>) => { askOnce: { disabled: boolean; disabledReason: string | null }; cacheInto: { disabled: boolean; disabledReason: string | null } };

describe('the HTTP request editor against httpRequestFields.jsx', () => {
    it('offers the web’s methods', () => {
        expect(`[${HTTP_METHODS.map((m) => `'${m}'`).join(', ')}]`).toBe(/const HTTP_METHODS = (\[[^\]]+\]);/.exec(src)?.[1]);
    });

    it.each([{}, { method: 'post' }, { method: 'DELETE', blockPrivateTargets: true }, { blockPrivateTargets: false }, { method: 'PUT', blockPrivateTargets: false }])('says what the web says about reuse for %j', (draft) => {
        const ours = reuseAvailability(draft);
        const theirs = webAvailability(draft);
        expect({ askOnce: { disabled: ours.askOnce.disabled, disabledReason: english(ours.askOnce.reason) }, cacheInto: { disabled: ours.cacheInto.disabled, disabledReason: english(ours.cacheInto.reason) } }).toEqual(theirs);
    });

    it('edits headers as the web does', () => {
        expect(addHeader({})).toEqual({ Header: '' });
        expect(Object.keys(addHeader({ Header: '', 'Header-1': '' }))).toEqual(['Header', 'Header-1', 'Header-2']);
        expect(Object.keys(renameHeader({ A: '1', B: '2' }, 'A', 'X') ?? {})).toEqual(['X', 'B']);
        expect(renameHeader({ A: '1' }, 'A', '')).toBeNull();
        expect(removeHeader({ A: '1', B: '2' }, 'A')).toEqual({ B: '2' });
    });

    it('names the credential kinds as the connections page does', () => {
        for (const type of kinds.HTTP_AUTH_TYPES) expect(HTTP_KIND_NAMES[type.kind]).toEqual([type.nameKey, type.name]);
    });

    it('keeps answers only in a table provisioned for it, readable by whom the web says', () => {
        const tables = [
            { id: 'a', name: 'A', canWrite: true, managedKind: 'http_cache', scope: 'org', columns: [] },
            { id: 'b', name: 'B', canWrite: false, managedKind: 'http_cache', columns: [] },
            { id: 'c', name: 'C', canWrite: true, columns: [] },
        ] as unknown as CatalogDatatable[];
        expect(answerTables(tables).map((t) => t.id)).toEqual(['a']);
        const audience = /const TABLE_AUDIENCE = \{([^}]+)\}/.exec(cacheSrc)?.[1] ?? '';
        expect(Object.fromEntries(Object.entries(TABLE_AUDIENCE).map(([k, m]) => [k, m[1]]))).toEqual(Object.fromEntries([...audience.matchAll(/(\w+): '([^']+)'/g)].map((m) => [m[1], m[2]])));
        expect(cacheDays(null)).toBe(30);
        expect(cacheTable({ datatableId: 'a', maxAgeDays: 7 }, 'z')).toEqual({ datatableId: 'z', maxAgeDays: 7 });
        expect(cacheTable(null, '')).toBeUndefined();
        expect(cacheForDays({ datatableId: 'a' }, '12.4')).toEqual({ datatableId: 'a', maxAgeDays: 12 });
        expect(cacheForDays(null, 5)).toBeNull();
    });
});

describe('what an HTTP edit saves', () => {
    const step = { id: 'h1', type: 'http_request', url: 'https://x', method: 'GET', headers: {}, timeoutMs: 10_000 } as unknown as FlowNode;
    const edit = (change: Record<string, unknown>) => buildPatch(step, { ...extractFormState(step), ...change });

    it('keeps only the connection id, and the auto parse as absence', () => {
        expect(edit({ auth: { connectionId: 'c1', secret: 'never' } }).auth).toEqual({ connectionId: 'c1' });
        expect(edit({ parseResponse: 'auto' })).not.toHaveProperty('parseResponse');
        expect(edit({ parseResponse: 'always' }).parseResponse).toBe('always');
    });

    it('clamps the timeout and upper-cases the method', () => {
        expect(edit({ timeoutMs: 999_999, method: 'post' })).toMatchObject({ timeoutMs: 60_000, method: 'POST' });
    });

    it('saves the two reuse ticks', () => {
        expect(edit({ askOnce: true, cacheInto: { datatableId: 'a', maxAgeDays: 7 } })).toMatchObject({ askOnce: true, cacheInto: { datatableId: 'a', maxAgeDays: 7 } });
    });
});
