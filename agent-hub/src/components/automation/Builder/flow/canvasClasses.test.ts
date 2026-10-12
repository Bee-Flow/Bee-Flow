import { describe, expect, it } from 'vitest';
import { NODE_FAMILIES } from './nodeDefs';
import { typeColorVar, typeTint, statusVar } from './nodeTypeColors';
import {
    CANVAS_CARD, DOT_GRID, FAMILY_TOKEN, STATUS_PILL, STATUS_PILL_LABEL, STATUS_RING, TRIGGER_RADIUS, familyClasses,
} from './canvasClasses';
import type { MiniFamily, MiniStatus } from './canvasClasses';

/** A CSS value as Tailwind writes it inside an arbitrary class: spaces become underscores, none after a comma. */
const tw = (css: string) => css.replace(/, /g, ',').replace(/ /g, '_');

const FAMILIES = Object.keys(FAMILY_TOKEN) as MiniFamily[];

describe('canvasClasses', () => {
    it('maps every mini family onto a real canvas family', () => {
        for (const f of FAMILIES) expect(NODE_FAMILIES).toContain(FAMILY_TOKEN[f]);
    });

    it('derives each family entry from typeColorVar / typeTint, not a second colour table', () => {
        for (const f of FAMILIES) {
            const token = FAMILY_TOKEN[f];
            const c = familyClasses(f);
            expect(c.tile).toContain(`bg-[${tw(typeTint(token))}]`);
            expect(c.tile).toContain(`text-[${typeColorVar(token)}]`);
            expect(c.text).toBe(`text-[${typeColorVar(token)}]`);
            expect(c.bar).toBe(`shadow-[inset_4px_0_0_${typeColorVar(token)},var(--shadow-sm)]`);
            expect(c.border).toBe(`border-[${typeColorVar(token)}]`);
        }
    });

    it('falls back to the app look for an unknown family', () => {
        expect(familyClasses('nope')).toEqual(familyClasses('app'));
        expect(familyClasses(null)).toEqual(familyClasses('app'));
    });

    it('paints status chrome with the shared status table colours', () => {
        const runtime: Record<MiniStatus, string | null> = {
            idle: null, running: 'running', done: 'success', skipped: null, error: 'error',
        };
        for (const [mini, canvas] of Object.entries(runtime) as Array<[MiniStatus, string | null]>) {
            const cssVar = canvas ? statusVar(canvas) : null;
            if (!cssVar) continue;
            expect(STATUS_RING[mini]).toContain(`!border-[${cssVar}]`);
            expect(STATUS_PILL[mini]).toBe(`bg-[${cssVar}]`);
        }
        expect(STATUS_RING.idle).toBe('');
        expect(STATUS_RING.running).toContain('animate-[bf-node-pulse');
        expect(STATUS_PILL_LABEL.done).toEqual({ key: 'automations.card.badge_done', en: 'done' });
    });

    it('keeps every class a static literal (no runtime-built strings)', () => {
        const all = [CANVAS_CARD, DOT_GRID, TRIGGER_RADIUS, ...Object.values(STATUS_RING),
            ...FAMILIES.flatMap(f => Object.values(familyClasses(f)))];
        for (const s of all) expect(s).not.toMatch(/\$\{|undefined|null/);
        expect(DOT_GRID).toContain('bg-[length:16px_16px]');
    });
});
