import { describe, expect, it, vi } from 'vitest';
import { STYLE_KNOB_HANDLERS, applyStyleKnobHandlers, collectStyleKnobHandlers, type StyleKnobHandler } from './styleKnobHandlers';
import type { InlineStyle, StyleKnobs } from './styleResolver.types';

// Test-only fixtures: no handler or group ships in this wave.
const GROUPS = [
    { name: 'glow', knobs: ['glow'] },
    { name: 'tilt', knobs: ['tilt', 'tiltAxis'] },
];
const glow: StyleKnobHandler = {
    node: (s, style) => {
        style.boxShadow = `0 0 8px var(--app-primary)`;
        return `app-glow-${String((s as Record<string, unknown>).glow)}`;
    },
};

describe('style knob handlers', () => {
    it('ships empty', () => {
        expect(STYLE_KNOB_HANDLERS).toEqual([]);
    });

    it('registers one handler per file, in file-name order, tied to its catalog group', () => {
        const tilt: StyleKnobHandler = { section: () => 'app-tilt' };
        const handlers = collectStyleKnobHandlers({ './styleKnobs/tilt.ts': { default: tilt }, './styleKnobs/glow.ts': { default: glow } }, GROUPS);
        expect(handlers.map((h) => [h.group, h.knobs])).toEqual([['glow', ['glow']], ['tilt', ['tilt', 'tiltAxis']]]);
    });

    it('refuses a file without a catalog group or without a handler', () => {
        expect(() => collectStyleKnobHandlers({ './styleKnobs/spin.ts': { default: glow } }, GROUPS)).toThrow(/no extension knob group "spin"/);
        expect(() => collectStyleKnobHandlers({ './styleKnobs/glow.ts': { default: {} } }, GROUPS)).toThrow(/node and\/or section handler/);
    });

    it('runs a handler only for a style that sets one of its knobs', () => {
        const node = vi.fn(glow.node);
        const handlers = collectStyleKnobHandlers({ './styleKnobs/glow.ts': { default: { node } } }, GROUPS);

        const untouched: InlineStyle = { padding: '8px' };
        expect(applyStyleKnobHandlers(handlers, { span: 6, glow: null } as StyleKnobs, untouched, 'node')).toBe('');
        expect(untouched).toEqual({ padding: '8px' });
        expect(node).not.toHaveBeenCalled();

        const style: InlineStyle = {};
        expect(applyStyleKnobHandlers(handlers, { glow: 'soft' } as StyleKnobs, style, 'node')).toBe(' app-glow-soft');
        expect(style.boxShadow).toBe('0 0 8px var(--app-primary)');
        // A node-only handler is not asked about a section.
        expect(applyStyleKnobHandlers(handlers, { glow: 'soft' } as StyleKnobs, {}, 'section')).toBe('');
    });
});
