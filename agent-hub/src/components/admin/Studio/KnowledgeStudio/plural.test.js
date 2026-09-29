/**
 * "1 sources" on the first screen of a section is the kind of wrong that
 * makes a careful product look careless, and every counted phrase in
 * Knowledge can genuinely be one.
 *
 * The second test is the one that would actually have caught it: the
 * CATALOGUE beats a component's inline t() fallback, so a base key still
 * holding the plural English renders "1 sources" no matter what the call
 * site says. Reading the fallback and calling it fixed proves nothing.
 */
import { describe, it, expect } from 'vitest';
import EN from '../../../../i18n/en-defaults';
import { nOf, pluralKey } from './plural';
import { sublineFor } from './sourceKinds';

const t = (key, fallback, params = {}) =>
    String(EN[key] ?? fallback).replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? `{${k}}`));

describe('pluralKey', () => {
    it('is the base key for exactly one and the _plural key otherwise', () => {
        expect(pluralKey('a.b', 1)).toBe('a.b');
        expect(pluralKey('a.b', 0)).toBe('a.b_plural');
        expect(pluralKey('a.b', 2)).toBe('a.b_plural');
        expect(pluralKey('a.b', '1')).toBe('a.b');
    });
});

describe('nOf', () => {
    it('reads correctly at one, at zero and at many', () => {
        expect(nOf(t, 'knowledge.n_sources', 1, '{count} source', '{count} sources')).toBe('1 source');
        expect(nOf(t, 'knowledge.n_sources', 0, '{count} source', '{count} sources')).toBe('0 sources');
        expect(nOf(t, 'knowledge.n_sources', 5, '{count} source', '{count} sources')).toBe('5 sources');
    });

    it('treats a missing count as zero rather than NaN', () => {
        expect(nOf(t, 'knowledge.n_documents', undefined, '{count} document', '{count} documents')).toBe('0 documents');
    });
});

describe('the catalogue itself', () => {
    // The catalogue WINS over the inline fallback, so a base key holding the
    // plural text is the bug, and the fallback cannot save it.
    const PAIRS = [
        'knowledge.n_sources', 'knowledge.n_documents', 'knowledge.n_auto_refresh',
        'knowledge.docs.pages', 'knowledge.docs.sheets',
        'knowledge.subline.folder', 'knowledge.subline.upload',
        'knowledge.subline.datatable', 'knowledge.subline.datatable_columns',
        'knowledge.subline.meeting',
        'knowledge.subline.webpage', 'knowledge.subline.webpage_site',
        'knowledge.subline.automation', 'knowledge.subline.legacy',
    ];

    it('carries both forms of every counted phrase', () => {
        const missing = PAIRS.flatMap(k => [k, `${k}_plural`]).filter(k => !(k in EN));
        expect(missing).toEqual([]);
    });

    it('never gives the singular form the plural words', () => {
        const wrong = PAIRS.filter(k => EN[k] === EN[`${k}_plural`]);
        expect(wrong, 'these read identically at 1 and at 5').toEqual([]);
    });
});

describe('sublineFor picks the form the count needs', () => {
    it('switches per kind on the document count', () => {
        const one = sublineFor({ kind: 'nextcloud_folder', documentCount: 1 });
        const many = sublineFor({ kind: 'nextcloud_folder', documentCount: 38 });
        expect(one.key).toBe('knowledge.subline.folder');
        expect(many.key).toBe('knowledge.subline.folder_plural');
        expect(t(one.key, '', one.params)).toBe('folder · 1 file');
        expect(t(many.key, '', many.params)).toBe('folder · 38 files');
    });

    it('leaves the uncounted text source alone', () => {
        // A text source is one pasted snippet; there is no count to agree with.
        const s = sublineFor({ kind: 'text', createdBy: { name: 'Tessa' } });
        expect(s.key).toBe('knowledge.subline.text');
        expect(t(s.key, '', s.params)).toBe('pasted text · by Tessa');
    });
});
