// @vitest-environment node
/**
 * A map keyed by a big number (Discord and Twitter snowflake ids, 18-20
 * digits) keeps its key: every path the builder writes for it is quoted
 * (`users["12345678901234567890"]`), because an index segment would be read
 * as a number above 2^53 and land on a different key. The canonical writer is
 * the shared one (path.mjs formatKey): this module has no number rule of its own.
 */
import { describe, expect, it } from 'vitest';
import { evaluate } from '@shared/expr/engine.mjs';
import { bindingFromInput, canonicalRefPath, formatPathForInsert, walkPath } from './bindingHelpers';

const KEY = '12345678901234567890';
const ROOT = { steps: { d: { output: { users: { [KEY]: { name: 'Ann' } }, list: ['a', 'b'] } } } };
const CANONICAL = `steps.d.output.users["${KEY}"].name`;

describe('a big numeric key', () => {
    it.each([
        `steps.d.output.users["${KEY}"].name`,
        `steps.d.output.users['${KEY}'].name`,
        `steps.d.output.users.${KEY}.name`,
        `steps.d.output.users[${KEY}].name`,
    ])('%s is stored quoted and resolves', (typed) => {
        expect(canonicalRefPath(typed)).toBe(CANONICAL);
        expect(bindingFromInput(typed, 'expression')).toEqual({ kind: 'ref', path: CANONICAL });
        expect(formatPathForInsert(typed, 'fixed')).toBe(`{{${CANONICAL}}}`);
        expect(walkPath(CANONICAL, ROOT)).toBe('Ann');
        // A formula reads the stored spelling as the same key.
        expect(evaluate(`upper(${CANONICAL})`, ROOT)).toBe('ANN');
    });

    it('a small index stays an index, and a sub-step path keeps its key too', () => {
        expect(canonicalRefPath('steps.d.output.list.1')).toBe('steps.d.output.list[1]');
        expect(walkPath(canonicalRefPath('steps.d.output.list.1'), ROOT)).toBe('b');
        expect(canonicalRefPath(`steps.call/sub.output.users.${KEY}`)).toBe(`steps.call/sub.output.users["${KEY}"]`);
    });
});
