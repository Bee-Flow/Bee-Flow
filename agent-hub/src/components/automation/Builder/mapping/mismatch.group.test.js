import { describe, it, expect } from 'vitest';
import { detectMismatch, mismatchSentence, remediesFor } from './mismatch';
import { walkPath, walkRelativePath } from '../../../../utils/bindingHelpers';

/**
 * The GROUP and TABLE branches of the one remedy source (artboard 2a/2c).
 *
 * Both existed only as a sentence before: `detectMismatch` returned
 * `group_into_one`, `mismatchSentence` had a branch for it, and nothing ever
 * reached either — BindingField hard-coded `actualKind="list"`, so a group
 * pick rendered the list remedies (join / first / count) and a table got the
 * same wrong menu. These tests pin what each branch now offers, and — the part
 * that matters — that every binding it writes is something the shared
 * expression engine really runs.
 */
const ROOT = {
    steps: {
        a: {
            output: {
                balance: { assets: 4120000, liabilities: 4120000, difference: 0, checked_by: 'Ada', note: 'ok' },
                result_rows: [
                    { bank: 'Rabobank', ratio: 1.2 },
                    { bank: 'ING', ratio: 0.9 },
                ],
                empty_group: {},
            },
        },
    },
};

// Every function name a remedy is allowed to emit — the whitelist both
// runtimes share (server/shared/expr/functions.mjs + its FE mirror).
const RUNNABLE = /^(join|first|last|count|asTable|groupSummary)\(/;

describe('a group dropped where one value fits', () => {
    it('offers the fields inside it, with the readable summary as the default', () => {
        const r = remediesFor('steps.a.output.balance', ROOT, { actualKind: 'group' });
        expect(r.defaultId).toBe('summary');
        expect(r.primary.map(x => x.id)).toEqual(['field:assets', 'field:liabilities', 'field:difference', 'summary']);
        expect(r.primary[0].binding).toEqual({ kind: 'ref', path: 'steps.a.output.balance.assets' });
        expect(r.primary[0].labelParams).toEqual({ field: 'Assets' });
        // The default is never a guess at which key the author meant.
        expect(r.primary[3].binding).toEqual({ kind: 'expr', value: 'groupSummary(steps.a.output.balance)' });
    });

    it('puts the remaining fields and the whole group behind "more"', () => {
        const r = remediesFor('steps.a.output.balance', ROOT, { actualKind: 'group' });
        expect(r.more.map(x => x.id)).toEqual(['field:checked_by', 'field:note', 'each']);
        expect(r.more.at(-1).binding).toEqual({ kind: 'ref', path: 'steps.a.output.balance' });
        expect(r.count).toBe(5);
    });

    it('still answers for a group with no fields — the summary and the group itself', () => {
        const r = remediesFor('steps.a.output.empty_group', ROOT, { actualKind: 'group' });
        expect(r.primary.map(x => x.id)).toEqual(['summary']);
        expect(r.more.map(x => x.id)).toEqual(['each']);
    });

    it('emits only bindings the engine runs', () => {
        const r = remediesFor('steps.a.output.balance', ROOT, { actualKind: 'group' });
        for (const rem of [...r.primary, ...r.more]) {
            if (rem.binding.kind === 'ref') expect(rem.binding.path).toMatch(/^steps\.a\.output\.balance/);
            else expect(rem.binding.value).toMatch(RUNNABLE);
        }
    });
});

describe('a table dropped where one value fits', () => {
    it('leads with "as a table" — never join/first, which give [object Object]', () => {
        const r = remediesFor('steps.a.output.result_rows', ROOT, { actualKind: 'table', allowForEach: true });
        expect(r.defaultId).toBe('table');
        expect(r.primary.map(x => x.id)).toEqual(['table', 'count', 'foreach']);
        expect(r.primary[0].binding).toEqual({ kind: 'expr', value: 'asTable(steps.a.output.result_rows)' });
        expect(r.primary[0].preview).toBe('Bank | Ratio');
        expect(r.primary.some(x => x.id === 'join')).toBe(false);
        expect(r.count).toBe(2);
    });

    it('keeps the first row, one block per row and the whole table behind "more"', () => {
        const r = remediesFor('steps.a.output.result_rows', ROOT, { actualKind: 'table' });
        expect(r.more.map(x => x.id)).toEqual(['first', 'summary', 'each']);
        expect(r.more.at(-1).binding).toEqual({ kind: 'ref', path: 'steps.a.output.result_rows' });
    });

    it('emits only bindings the engine runs', () => {
        const r = remediesFor('steps.a.output.result_rows', ROOT, { actualKind: 'table', allowForEach: true });
        for (const rem of [...r.primary, ...r.more]) {
            // "a separate run for each row" binds the LOOP item the forEach it
            // also carries introduces — the one ref that is not under the path.
            if (rem.binding.kind === 'ref') expect(rem.binding.path).toMatch(/^(steps\.a\.output\.result_rows|loop\.)/);
            else expect(rem.binding.value).toMatch(RUNNABLE);
        }
    });
});

describe('the kind decides the question, and it is read from the data when not given', () => {
    it('reads the actual kind off the sample when the caller does not pass one', () => {
        expect(remediesFor('steps.a.output.balance', ROOT).defaultId).toBe('summary');
        expect(remediesFor('steps.a.output.result_rows', ROOT).defaultId).toBe('table');
    });

    it('the sentence matches the branch, in words', () => {
        expect(mismatchSentence({ actualKind: 'table', expectedKind: 'text', count: 14 }))
            .toBe('is a table of 14 rows, this needs one text. It can go in as a table.');
        expect(mismatchSentence({ actualKind: 'group', expectedKind: 'text' }))
            .toBe('is a group, this needs one text. Pick a field inside it.');
    });

    it('detectMismatch tells the three apart, so the box can pick a branch', () => {
        expect(detectMismatch({ actualKind: 'group', expectedKind: 'choice' })?.code).toBe('group_into_one');
        expect(detectMismatch({ actualKind: 'table', expectedKind: 'date' })?.code).toBe('table_into_one');
        // A table into a LIST slot is not a mismatch — kindFits says it fits.
        expect(detectMismatch({ actualKind: 'table', expectedKind: 'list' })).toBeNull();
    });
});


/**
 * The group branch builds a path out of a key it did not write, and the keys
 * it gets handed come from an HTTP or webhook body: `content-type`,
 * `x-request-id`, `first name`. That is the whole reason this branch exists,
 * so it is also where an unquoted key does the most damage.
 *
 * The two resolvers are deliberately different, and that is what makes a raw
 * key dangerous rather than merely wrong:
 *   - `walkPath` (the BUILDER's preview) skips the syntax check on purpose —
 *     it previews saved paths verbatim — so `body.content-type` shows the
 *     real value under the button.
 *   - `walkRelativePath` enforces REF_RE, which is a byte-for-byte mirror of
 *     the server binder's. It is the run's answer.
 * A raw key makes those two disagree: green preview, empty field at run time,
 * no warning anywhere. So every binding this branch emits is checked against
 * the RUN's resolver, not the preview's.
 */
const HEADERS = {
    trigger: {
        output: {
            body: {
                'content-type': 'application/json',
                'first name': 'Alice',
                ok: 'yes',
                'x-request-id': 'req-7',
            },
        },
    },
};

describe('a group whose keys are not identifiers (the webhook case)', () => {
    it('quotes every key it hands to a binding, so the RUN resolves what the preview shows', () => {
        const r = remediesFor('trigger.output.body', HEADERS, { actualKind: 'group' });
        const fields = [...r.primary, ...r.more].filter(x => x.id.startsWith('field:'));
        expect(fields.map(x => x.id)).toEqual([
            'field:content-type', 'field:first name', 'field:ok', 'field:x-request-id',
        ]);
        for (const f of fields) {
            const key = f.id.slice('field:'.length);
            const want = HEADERS.trigger.output.body[key];
            // What the button PROMISES (its preview) …
            expect(f.preview).toBe(want);
            // … is what the builder resolves …
            expect(walkPath(f.binding.path, HEADERS)).toBe(want);
            // … AND what the runtime's own rule resolves. This is the
            // assertion that was false: `trigger.output.body.content-type`
            // passes the first two and returns undefined here.
            expect(walkRelativePath(f.binding.path, HEADERS)).toBe(want);
        }
    });

    it('writes the bracket form, not a dotted hyphen', () => {
        const r = remediesFor('trigger.output.body', HEADERS, { actualKind: 'group' });
        const byId = Object.fromEntries([...r.primary, ...r.more].map(x => [x.id, x]));
        expect(byId['field:content-type'].binding).toEqual({ kind: 'ref', path: 'trigger.output.body["content-type"]' });
        expect(byId['field:first name'].binding).toEqual({ kind: 'ref', path: 'trigger.output.body["first name"]' });
        // An identifier-safe key stays plain — no gratuitous quoting.
        expect(byId['field:ok'].binding).toEqual({ kind: 'ref', path: 'trigger.output.body.ok' });
    });

    it('offers a key holding `]` too, with a path the run resolves', () => {
        // The shared grammar (shared/expr/path.mjs) reads JSON-escaped quoted
        // keys, so `["a]b"]` is a path like any other. It used to be left off
        // the menu because the old tokenizer split on the first `]`.
        const odd = { trigger: { output: { body: { 'a]b': 1, plain: 2 } } } };
        const r = remediesFor('trigger.output.body', odd, { actualKind: 'group' });
        const byId = Object.fromEntries([...r.primary, ...r.more].map(x => [x.id, x]));
        expect(byId['field:plain']).toBeTruthy();
        expect(byId['field:a]b'].binding).toEqual({ kind: 'ref', path: 'trigger.output.body["a]b"]' });
        expect(walkRelativePath(byId['field:a]b'].binding.path, odd)).toBe(1);
        expect(byId.summary).toBeTruthy();
    });

    it('the summary and the whole-group answers are unaffected — they never name a key', () => {
        const r = remediesFor('trigger.output.body', HEADERS, { actualKind: 'group' });
        const byId = Object.fromEntries([...r.primary, ...r.more].map(x => [x.id, x]));
        expect(byId.summary.binding).toEqual({ kind: 'expr', value: 'groupSummary(trigger.output.body)' });
        expect(byId.each.binding).toEqual({ kind: 'ref', path: 'trigger.output.body' });
        expect(r.defaultId).toBe('summary');
    });
});
