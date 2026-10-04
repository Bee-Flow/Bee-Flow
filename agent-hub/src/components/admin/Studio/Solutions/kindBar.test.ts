import { describe, expect, it } from 'vitest';
import { kindBarClass, kindInkClass } from './kindBar';

describe('kindBar', () => {
    it('maps API spellings onto the kind colour', () => {
        expect(kindBarClass('knowledge_base')).toContain('--kind-kb');
        expect(kindInkClass('automation')).toContain('--type-trigger');
    });
    it('falls back to a neutral colour for an unknown kind', () => {
        expect(kindBarClass('approval')).toContain('--text-tertiary');
        expect(kindInkClass('nope')).toContain('--text-tertiary');
    });
});
