import { describe, expect, it, vi } from 'vitest';
import { extensionKnobGroups } from './catalogSnapshot.generated.json';
import { STYLE_KNOB_HANDLERS, STYLE_KNOB_LABELS, applyStyleKnobHandlers, collectStyleKnobHandlers, collectStyleKnobLabels, type StyleKnobHandler } from './styleKnobHandlers';
import type { InlineStyle, StyleKnobs } from './styleResolver.types';

// Test-only fixtures: whatever ships is only held to the rules in the first test.
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
    it('every knob group of the catalog has its handler file, and that file names each of its knobs', () => {
        const groups = extensionKnobGroups as ReadonlyArray<{ name: string; knobs: readonly string[] }>;
        // A group the server added (componentSpecs/styleKnobGroups/<group>.js) without its file here is never drawn.
        expect(STYLE_KNOB_HANDLERS.map((h) => h.group).sort(), 'add runtime/styleKnobs/<group>.ts for each knob group').toEqual(groups.map((g) => g.name).sort());
        for (const group of groups) {
            for (const knob of group.knobs) {
                expect(STYLE_KNOB_LABELS[knob]?.[1], `runtime/styleKnobs/${group.name}.ts: add labels.${knob} = [i18n key, English]`).toBeTruthy();
            }
        }
    });

    it('collects the labels of a handler for the knobs of its own group only', () => {
        const handlers = collectStyleKnobHandlers({
            './styleKnobs/glow.ts': { default: { ...glow, labels: { glow: ['look.glow', 'Glow'], tilt: ['look.tilt', 'Not mine'] } } },
            './styleKnobs/tilt.ts': { default: { section: () => '', labels: { tilt: ['look.tilt', 'Tilt'] } } },
        }, GROUPS);
        expect(collectStyleKnobLabels(handlers)).toEqual({ glow: ['look.glow', 'Glow'], tilt: ['look.tilt', 'Tilt'] });
        expect(collectStyleKnobLabels([])).toEqual({});
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
