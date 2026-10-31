// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { sharedGroupsOf } from './sharedGroups';

describe('sharedGroupsOf', () => {
    it('reads the TEXT column as the detail route sends it, never as characters', () => {
        expect(sharedGroupsOf({ shared_groups: '[]' })).toEqual([]);
        expect(sharedGroupsOf({ shared_groups: '["g1","g2"]' })).toEqual(['g1', 'g2']);
    });

    it('accepts an array, the camelCase name, and junk', () => {
        expect(sharedGroupsOf({ shared_groups: ['g1'] })).toEqual(['g1']);
        expect(sharedGroupsOf({ sharedGroups: ['g2'] })).toEqual(['g2']);
        expect(sharedGroupsOf({ shared_groups: 'not json' })).toEqual([]);
        expect(sharedGroupsOf({ shared_groups: '{"a":1}' })).toEqual([]);
        expect(sharedGroupsOf(null)).toEqual([]);
    });
});
