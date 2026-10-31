// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { kindColorVar, kindIcon, kindTileStyle, kindTint } from './kindColors';

/**
 * The per-kind lookups answer a fallback for a kind they do not know, and for
 * a missing one (null / undefined) — the lookup `MAP[kind]` with a nullable key
 * is written with an explicit null check so it can be typed; the answers stay.
 */

describe('kindColors — missing and unknown kinds', () => {
    it('kindColorVar falls back to the neutral ink', () => {
        for (const kind of [null, undefined, '', 'nope', 'null', 'undefined']) {
            expect(kindColorVar(kind)).toBe('var(--text-tertiary)');
        }
    });

    it('kindColorVar answers the variable of a known kind', () => {
        expect(kindColorVar('kb')).toBe('var(--kind-kb)');
        expect(kindColorVar('agent')).toBe('var(--type-ai)');
    });

    it('kindIcon is null for a missing or unknown kind', () => {
        for (const kind of [null, undefined, '', 'nope', 'null', 'undefined']) {
            expect(kindIcon(kind)).toBeNull();
        }
        expect(kindIcon('kb')).not.toBeNull();
    });

    it('kindTint and kindTileStyle use the neutral ink for a missing kind', () => {
        expect(kindTint(null, 10)).toBe('color-mix(in srgb, var(--text-tertiary) 10%, transparent)');
        expect(kindTint(undefined)).toBe('color-mix(in srgb, var(--text-tertiary) 16%, transparent)');
        expect(kindTileStyle(null, 28).tile.color).toBe('var(--text-tertiary)');
        expect(kindTileStyle(undefined, 28).tile.borderRadius).toBe('8px');
    });
});
