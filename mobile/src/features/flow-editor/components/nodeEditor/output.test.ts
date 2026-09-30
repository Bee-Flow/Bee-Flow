import { MAX_PINNED_BYTES } from '@/features/flow-editor/formState/outputDrafts';

import { copyText, previewOf, treeRows, treeWords } from './jsonTree';
import { checkOutputText, editedOutputPatch, outputSeed, outputState, pinPatch, shownOutput, unpinPatch } from './outputEdit';

describe('checkOutputText', () => {
    it('accepts JSON a step could have produced', () => {
        expect(checkOutputText('{"total": 3}')).toEqual({ ok: true, value: { total: 3 } });
        expect(checkOutputText('[1, 2]')).toEqual({ ok: true, value: [1, 2] });
    });

    it('refuses what cannot be pinned, and says why in the web’s words', () => {
        expect(checkOutputText('{oops')).toMatchObject({ ok: false, error: expect.stringMatching(/^Invalid JSON: /) });
        expect(checkOutputText('null')).toEqual({ ok: false, error: 'Nothing to save — use Remove to clear the saved output.' });
        expect(checkOutputText('{"__truncated__": true}')).toMatchObject({ ok: false, error: expect.stringContaining('placeholder') });
        const big = JSON.stringify({ blob: 'x'.repeat(MAX_PINNED_BYTES) });
        expect(checkOutputText(big)).toMatchObject({ ok: false, error: expect.stringMatching(/^Too big to save: \d+ KB, and the limit is 64 KB/) });
    });
});

describe('pins', () => {
    const now = new Date('2026-09-24T10:00:00Z');

    it('captures, edits and clears as the web writes them', () => {
        expect(pinPatch({ a: 1 }, now)).toEqual({ pinnedOutput: { a: 1 }, pinnedAt: '2026-09-24T10:00:00.000Z', pinnedSource: undefined });
        expect(editedOutputPatch({ a: 2 }, now)).toEqual({ pinnedOutput: { a: 2 }, pinnedAt: '2026-09-24T10:00:00.000Z', pinnedSource: 'edited' });
        expect(unpinPatch()).toEqual({ pinnedOutput: null, pinnedAt: null, pinnedSource: undefined });
    });

    it('tells a capture from a hand-written value, and never pins the placeholder', () => {
        expect(outputState({ pinnedOutput: { a: 1 } }, null)).toEqual({ pinned: true, edited: false, canPin: false });
        expect(outputState({ pinnedOutput: { a: 1 }, pinnedSource: 'edited' }, { b: 1 })).toEqual({ pinned: true, edited: true, canPin: true });
        expect(outputState({}, { __truncated__: true })).toMatchObject({ canPin: false });
    });

    it('opens the editor on the freshest value there is', () => {
        expect(JSON.parse(outputSeed({ run: 1 }, { pin: 1 }, { sample: 1 }))).toEqual({ run: 1 });
        expect(JSON.parse(outputSeed(undefined, { pin: 1 }, { sample: 1 }))).toEqual({ pin: 1 });
        expect(JSON.parse(outputSeed(undefined, undefined, undefined))).toEqual({});
    });
});

describe('treeRows', () => {
    const value = { name: 'Ann', items: [{ id: 1 }, { id: 2 }], ok: true, none: null };

    it('lists the top level, containers closed', () => {
        expect(treeRows(value).map((r) => [r.id, r.kind, r.preview])).toEqual([
            ['$.name', 'string', '"Ann"'],
            ['$.items', 'array', '[2]'],
            ['$.ok', 'boolean', 'true'],
            ['$.none', 'null', 'null'],
        ]);
    });

    it('opens a container on request, nested paths and all', () => {
        const rows = treeRows(value, new Set(['$.items', '$.items[1]']));
        expect(rows.map((r) => `${'  '.repeat(r.depth)}${r.key}`)).toEqual(['name', 'items', '  [0]', '  [1]', '    id', 'ok', 'none']);
        expect(rows.find((r) => r.id === '$.items[1].id')?.value).toBe(2);
    });

    it('shows a scalar as one row, and stops at the limit', () => {
        expect(treeRows('plain')).toEqual([expect.objectContaining({ id: '$', kind: 'string', preview: '"plain"' })]);
        expect(treeRows(Array.from({ length: 900 }, (_, i) => i), new Set(), 500)).toHaveLength(500);
    });

    it('copies a string as itself and anything else as JSON', () => {
        expect(copyText('hi')).toBe('hi');
        expect(copyText({ a: 1 })).toBe('{\n  "a": 1\n}');
        expect(previewOf('x'.repeat(200)).length).toBe(120);
    });
});

describe('shownOutput', () => {
    it('shows what is pinned or written by hand over the last test run', () => {
        expect(shownOutput({ pinnedOutput: { hand: 1 } }, { run: 1 })).toEqual({ hand: 1 });
        expect(shownOutput({ pinnedOutput: null }, { run: 1 })).toEqual({ run: 1 });
        expect(shownOutput({}, undefined)).toBeUndefined();
    });

    it('so Edit opens on the saved output, not the older run', () => {
        const step = { pinnedOutput: { hand: 1 } };
        expect(JSON.parse(outputSeed(shownOutput(step, { run: 1 }), step.pinnedOutput, undefined))).toEqual({ hand: 1 });
    });
});

describe('treeRows, read as words', () => {
    const english = (_key: string, fallback: string, params?: Record<string, string | number>) =>
        fallback.replace(/\{(\w+)\}/g, (_m, k: string) => String(params?.[k] ?? ''));
    const words = treeWords(english);
    const value = { from_email: 'ann@x.nl', items: [{ id: 1 }, { id: 2 }], one: [1], meta: { a: 1 }, ok: true, none: null };

    it('says sizes, text, Yes and — where the raw tree says [2], "…", true and null', () => {
        expect(treeRows(value, new Set(), 500, words).map((r) => [r.key, r.preview])).toEqual([
            ['From email', 'ann@x.nl'],
            ['Items', '2 items'],
            ['One', '1 item'],
            ['Meta', '1 field'],
            ['Ok', 'Yes'],
            ['None', '—'],
        ]);
    });

    it('numbers a list’s entries from one, and keeps the paths the raw tree uses', () => {
        const rows = treeRows(value, new Set(['$.items']), 500, words);
        expect(rows.filter((r) => r.depth === 1).map((r) => [r.id, r.key, r.preview])).toEqual([
            ['$.items[0]', '#1', '1 field'],
            ['$.items[1]', '#2', '1 field'],
        ]);
    });

    it('a scalar output is one row, as itself', () => {
        expect(previewOf('plain', words)).toBe('plain');
        expect(previewOf(false, words)).toBe('No');
        expect(treeRows('plain', new Set(), 500, words)[0]?.preview).toBe('plain');
    });
});
