// @vitest-environment node
import { getPath, getRelativePath } from '@shared/expr/path.mjs';
import { describe, it, expect } from 'vitest';
import { joinKeyPath, keyPickable } from './keyPath';
import { walkPath } from '../../../../utils/bindingHelpers';

/**
 * The one rule for writing an object key down as a path.
 *
 * A path written badly is not a visible error: it is a green preview over a
 * field that arrives empty. Every assertion below therefore checks the path
 * against the builder's preview walker AND the runtime's resolver
 * (shared/expr/path.mjs), not against a string.
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
        // A key holding a double quote is JSON-escaped: the runtime grammar
        // reads escapes (it used to read none, and this key needed single
        // quotes).
        expect(joinKeyPath('a.b', 'he said "hi"')).toBe('a.b["he said \\"hi\\""]');
        // An index-like key reads as an index, which resolves an object key "0" too.
        expect(joinKeyPath('a.b', '0')).toBe('a.b[0]');
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
            expect(getPath(ROOT, path)).toBe(want);
            expect(getRelativePath(ROOT.trigger.output.body, joinKeyPath('', key))).toBe(want);
        }
    });
});

describe('keyPickable', () => {
    it('accepts every key that has a path', () => {
        for (const key of KEYS) expect(keyPickable(key)).toBe(true);
    });

    it('accepts the keys the old dialect could not write down', () => {
        // The grammar used to know no escapes, so a `]` ended the bracket early
        // and a key holding BOTH quote styles had no quote left to wrap it in.
        // It reads JSON escapes now: answered by probing the real resolver, so
        // this can never drift from the resolver's own rules.
        for (const key of ['a]b', 'he said "hi" and \'bye\'', 'back\\slash', 'a}}b', 'new\nline']) {
            expect(keyPickable(key)).toBe(true);
            expect(getPath({ x: { [key]: 1 } }, joinKeyPath('x', key))).toBe(1);
        }
    });

    it('never throws, whatever it is handed', () => {
        // The empty key is legal, oddly enough — `body[""]` resolves on both
        // sides — and the probe says so rather than guessing.
        expect(keyPickable('')).toBe(true);
        expect(keyPickable('...')).toBe(true);
        expect(() => keyPickable(null)).not.toThrow();
    });
});
