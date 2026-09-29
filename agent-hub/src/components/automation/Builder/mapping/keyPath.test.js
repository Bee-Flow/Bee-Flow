// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { joinKeyPath, keyPickable } from './keyPath';
import { walkPath, walkRelativePath } from '../../../../utils/bindingHelpers';

/**
 * The one rule for writing an object key down as a path.
 *
 * It exists because the builder and the runtime resolve paths DIFFERENTLY on
 * purpose: `walkPath` previews saved paths verbatim (no syntax check), while
 * the run enforces REF_RE. A key like `content-type` slips through the first
 * and is rejected by the second, so an unquoted path is not a visible error —
 * it is a green preview over a field that arrives empty. Every assertion below
 * therefore checks the path against BOTH, not against a string.
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
