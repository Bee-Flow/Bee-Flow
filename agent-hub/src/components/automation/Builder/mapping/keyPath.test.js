// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { columnKeyOf, joinKeyPath, keyPickable } from './keyPath';
import { walkPath, walkRelativePath } from '../../../../utils/bindingHelpers';

/**
 * The one rule for writing an object key down as a path.
 *
 * It exists because the run enforces REF_RE: a key like `content-type`
 * written unquoted is rejected, and the field arrives empty. The builder's
 * `walkPath` used to preview such a path verbatim (a green preview over an
 * empty field); it is the runtime's own walker now (shared/mapping). Every
 * assertion below still checks the path against BOTH walkers, not against a
 * string, so neither can drift back.
 */
const ROOT = {
    trigger: {
        output: {
            body: {
                'content-type': 'application/json',
                'first name': 'Alice',
                'x-request-id': 'req-7',
                plain: 'ok',
                '1st': 'numeric start',
                'he said "hi"': 'quoted',
            },
        },
    },
};
const KEYS = Object.keys(ROOT.trigger.output.body);

describe('joinKeyPath', () => {
    it('leaves an identifier-safe key plain and quotes everything else', () => {
        expect(joinKeyPath('a.b', 'plain')).toBe('a.b.plain');
        expect(joinKeyPath('a.b', 'content-type')).toBe('a.b["content-type"]');
        expect(joinKeyPath('a.b', 'first name')).toBe('a.b["first name"]');
        expect(joinKeyPath('a.b', '1st')).toBe('a.b["1st"]');       // a digit start is not an identifier
        expect(joinKeyPath('a.b', '$ok')).toBe('a.b.$ok');
        // A key holding a double quote flips to single quotes: the tokenizer
        // accepts both styles and supports no escapes, so this is the only
        // form that can be written at all.
        expect(joinKeyPath('a.b', 'he said "hi"')).toBe('a.b[\'he said "hi"\']');
    });

    it('an empty prefix yields a ROOT segment, not a leading dot', () => {
        expect(joinKeyPath('', 'plain')).toBe('plain');
        expect(joinKeyPath('', 'content-type')).toBe('["content-type"]');
    });

    it('every key it writes resolves the same in the preview AND in the run', () => {
        // The whole point, in one loop. `${p}.${key}` passes the first of
        // these and fails the second for four of these six keys.
        for (const key of KEYS) {
            const path = joinKeyPath('trigger.output.body', key);
            const want = ROOT.trigger.output.body[key];
            expect(walkPath(path, ROOT)).toBe(want);
            expect(walkRelativePath(path, ROOT)).toBe(want);
        }
    });
});

describe('keyPickable', () => {
    it('accepts every key that has a path', () => {
        for (const key of KEYS) expect(keyPickable(key)).toBe(true);
    });

    it('refuses the keys the dialect genuinely cannot write down', () => {
        // No escapes: a `]` ends the bracket early, and a key holding BOTH
        // quote styles has no quote left to wrap it in. Answered by probing
        // the real resolver, so this can never drift from the resolver's own
        // rules the way a second regex would.
        expect(keyPickable('a]b')).toBe(false);
        expect(keyPickable('he said "hi" and \'bye\'')).toBe(false);
    });

    it('never throws, whatever it is handed', () => {
        // The empty key is legal, oddly enough — `body[""]` resolves on both
        // sides — and the probe says so rather than guessing.
        expect(keyPickable('')).toBe(true);
        expect(keyPickable('...')).toBe(true);
        expect(() => keyPickable(null)).not.toThrow();
    });
});

describe('columnKeyOf', () => {
    // FieldKeyCombobox stores this as the column a Set/Sort/Dedupe step reads
    // with `item?.[key]`: a quoted key has to come back unquoted, or the step
    // looks for a column called `rows[*]["first name"]`.
    it('reads the last key through brackets, quotes and list markers', () => {
        expect(columnKeyOf('steps.x.output.rows[*]["first name"]')).toBe('first name');
        expect(columnKeyOf('steps.x.output["content-type"]')).toBe('content-type');
        expect(columnKeyOf('steps.s1.output["line-items"][*]["unit price"]')).toBe('unit price');
        expect(columnKeyOf(`steps.s1.output.rows[*]['he said "hi"']`)).toBe('he said "hi"');
        expect(columnKeyOf('steps.x.output.results[*].subject')).toBe('subject');
        expect(columnKeyOf('steps.x.output.items[0]')).toBe('items');
        expect(columnKeyOf('subject')).toBe('subject');
    });

    it('reads a hand-typed path the way it was meant, and gives up on nothing', () => {
        expect(columnKeyOf('steps.x.output.Order date')).toBe('Order date');
        expect(columnKeyOf('')).toBe('');
        expect(columnKeyOf(null)).toBe('');
    });
});
