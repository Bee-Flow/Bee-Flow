import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lucide from 'lucide-react';
import { describe, it, expect } from 'vitest';

import { KIND_KEYS, kindOf, kindColorVar, kindTint, kindTileStyle, cardRadius, kindIcon } from './kindColors';

/**
 * The completeness net for the kind palette, copied from
 * automation/Builder/flow/nodeTypeColors.test.js.
 *
 * A colour map fails quietly: the forgotten kind renders grey, the
 * misspelled token paints NOTHING (an undeclared var() substitutes to
 * transparent), and a token declared in the dark set but not the light one
 * looks fine on the developer's theme and vanishes on the customer's. So
 * this file proves, for every kind, that it has a colour, an icon and a
 * shape, and that every CSS variable the module emits is declared in EVERY
 * one of the eight theme blocks of src/index.css.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_CSS = fs.readFileSync(path.resolve(HERE, '../../index.css'), 'utf8');
const SELF = fs.readFileSync(path.join(HERE, 'kindColors.js'), 'utf8');

const THEMES = ['dark', 'light', 'glass', 'glass-dark', 'high-contrast', 'paper', 'obsidian', 'sepia'];
const NO_COMMENTS = INDEX_CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Which themes declare `token` in a TOP-LEVEL theme block — `:root` (the
 * default dark theme) or `[data-theme="x"]`, alone or in a comma list? A
 * declaration under a scoped selector (`[data-theme="glass"] .foo`) does not
 * count: it is not available to a tile outside `.foo`.
 */
function themesDeclaring(token) {
    const covered = new Set();
    const declares = new RegExp(`${token}\\s*:`);
    for (const m of NO_COMMENTS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!declares.test(m[2])) continue;
        const selectors = m[1].split(';').pop().split(',').map(s => s.trim()).filter(Boolean);
        if (!selectors.every(s => s === ':root' || /^\[data-theme="[a-z-]+"\]$/.test(s))) continue;
        for (const s of selectors) covered.add(s === ':root' ? 'dark' : s.match(/"([a-z-]+)"/)[1]);
    }
    return covered;
}

const EMITTED = [...new Set([...SELF.matchAll(/var\((--[a-z0-9-]+)\)/g)].map(m => m[1]))];

describe('kindColors — twelve kinds, one legend', () => {
    it('KIND_KEYS are the nine tiles of artboard 1b plus document, playbook, solution and compliance, in rail order', () => {
        expect([...KIND_KEYS]).toEqual([
            'automation', 'datatable', 'app', 'webpage', 'document', 'form',
            'agent', 'skill', 'kb', 'meeting',
            'playbook', 'solution',
            'compliance',
        ]);
    });

    for (const kind of KIND_KEYS) {
        it(`${kind} has a colour var, a tint, an icon and a shape`, () => {
            expect(kindColorVar(kind)).toMatch(/^var\(--[a-z-]+\)$/);
            expect(kindTint(kind)).toBe(`color-mix(in srgb, ${kindColorVar(kind)} 16%, transparent)`);
            expect(kindIcon(kind), `${kind} has no icon`).toBeTruthy();
            expect(cardRadius(kind)).toMatch(/px$/);
        });
    }

    it('the four family-sharing kinds reuse the --type-* token (1b: "blauw · zelfde als AI-stap")', () => {
        expect(kindColorVar('automation')).toBe('var(--type-trigger)');
        expect(kindColorVar('datatable')).toBe('var(--type-data)');
        expect(kindColorVar('form')).toBe('var(--type-pause)');
        expect(kindColorVar('agent')).toBe('var(--type-ai)');
    });

    it('the seven Studio-only kinds own a --kind-* token; a solution is deliberately neutral', () => {
        expect(kindColorVar('playbook')).toBe('var(--kind-playbook)');
        expect(kindColorVar('compliance')).toBe('var(--kind-compliance)');
        expect(kindColorVar('app')).toBe('var(--kind-app)');
        expect(kindColorVar('webpage')).toBe('var(--kind-web)');
        expect(kindColorVar('skill')).toBe('var(--kind-skill)');
        expect(kindColorVar('kb')).toBe('var(--kind-kb)');
        expect(kindColorVar('meeting')).toBe('var(--kind-meet)');
        expect(kindColorVar('solution')).toBe('var(--text-secondary)');
    });

    it('an unknown kind falls back to an ink and never throws', () => {
        expect(kindColorVar(null)).toBe('var(--text-tertiary)');
        expect(kindColorVar('nope')).toBe('var(--text-tertiary)');
        expect(kindIcon('nope')).toBeNull();
        expect(kindTint(undefined, 8)).toBe('color-mix(in srgb, var(--text-tertiary) 8%, transparent)');
    });
});

describe('kindColors — every variable it emits is declared in EVERY theme block of src/index.css', () => {
    it('the source scan found the module\'s tokens', () => {
        expect(EMITTED).toEqual(expect.arrayContaining(['--kind-app', '--kind-web', '--kind-skill', '--kind-kb', '--kind-meet', '--kind-playbook', '--kind-compliance', '--type-trigger', '--type-ai', '--text-secondary', '--text-tertiary']));
    });

    for (const token of EMITTED) {
        it(`${token} is declared for all eight themes`, () => {
            const covered = themesDeclaring(token);
            expect(THEMES.filter(t => !covered.has(t)), `${token} is missing in these themes`).toEqual([]);
        });
    }

    it('the --kind-* tokens and the --*-ink pair sit in BOTH the dark and the light set', () => {
        // Same block regexes as nodeTypeColors.test.js, keyed on --kind-app.
        const dark = INDEX_CSS.match(/:root,\n\[data-theme="glass-dark"\],\n\[data-theme="obsidian"\] \{[^}]*--kind-app[^}]*\}/);
        const light = INDEX_CSS.match(/\[data-theme="light"\],\n\[data-theme="glass"\],\n\[data-theme="high-contrast"\],\n\[data-theme="paper"\],\n\[data-theme="sepia"\] \{[^}]*--kind-app[^}]*\}/);
        expect(dark, 'dark --kind-* block').toBeTruthy();
        expect(light, 'light --kind-* block').toBeTruthy();
        for (const t of ['--kind-app', '--kind-web', '--kind-skill', '--kind-kb', '--kind-meet', '--kind-playbook', '--kind-compliance', '--success-ink', '--warning-ink', '--error-ink']) {
            expect(dark[0], `dark set lacks ${t}`).toContain(`${t}:`);
            expect(light[0], `light set lacks ${t}`).toContain(`${t}:`);
        }
    });

    it('the --kind-* block sits directly after the --type-* block (third two-set block, one place to look)', () => {
        const typeLight = INDEX_CSS.indexOf('--type-guard: #2e6f86;');
        const kindBlock = INDEX_CSS.indexOf('--kind-app');
        const rootBlock = INDEX_CSS.indexOf('\n:root {\n');
        expect(typeLight).toBeGreaterThan(0);
        expect(kindBlock).toBeGreaterThan(typeLight);
        expect(rootBlock).toBeGreaterThan(kindBlock);
    });

    it('the retuned pair is NOT its --type-* twin — the legend must teach nine kinds, not eight', () => {
        const value = (t) => {
            const m = NO_COMMENTS.match(new RegExp(`${t}:\\s*(#[0-9a-f]{6})`, 'g')) || [];
            return m.map(s => s.slice(-7));
        };
        const [webDark, webLight] = value('--kind-web');
        const [loopDark, loopLight] = value('--type-loop');
        const [meetDark, meetLight] = value('--kind-meet');
        const [pauseDark, pauseLight] = value('--type-pause');
        expect(webLight).not.toBe(loopLight);
        expect(webDark).not.toBe(loopDark);
        expect(meetLight).not.toBe(pauseLight);
        expect(meetDark).not.toBe(pauseDark);
        // Third retune (2026-09-14): the Compliance artboards' #2e6f86 IS the
        // light --type-guard; a guard step and the Compliance area would share
        // one colour in the builder legend.
        const [guardDark, guardLight] = value('--type-guard');
        const [compDark, compLight] = value('--kind-compliance');
        expect(compLight).toBe('#1b6067');
        expect(compDark).toBe('#3eb3bd');
        expect(compLight).not.toBe(guardLight);
        expect(compDark).not.toBe(guardDark);
        // And the artboard values survive where they collide with nothing.
        expect(value('--kind-app')[1]).toBe('#6b4fbb');
        expect(value('--kind-skill')[1]).toBe('#c2661f');
        expect(value('--kind-kb')[1]).toBe('#8a6d1f');
    });

    it('emits no hex and never leans on the grey --accent', () => {
        const hexes = [...SELF.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(m => m[0]);
        expect(hexes).toEqual([]);
        expect(SELF).not.toMatch(/var\(--accent\)/);
        expect(SELF).not.toMatch(/var\(--accent-primary\)/);
    });

    it('is a leaf: imports lucide-react and nothing else', () => {
        const imports = [...SELF.matchAll(/^import .* from '([^']+)';/gm)].map(m => m[1]);
        expect(imports).toEqual(['lucide-react']);
    });
});

describe('kindColors — icons are the lucide exports artboard 1b names', () => {
    const EXPECTED = {
        automation: 'Workflow', datatable: 'Table', app: 'LayoutGrid', webpage: 'Globe', form: 'ClipboardList',
        agent: 'Bot', skill: 'Zap', kb: 'BookOpen', meeting: 'Mic', solution: 'Package',
        playbook: 'Clapperboard', compliance: 'Scale',
    };
    for (const [kind, name] of Object.entries(EXPECTED)) {
        it(`${kind} → lucide ${name}`, () => {
            expect(lucide[name], `lucide-react has no export ${name}`).toBeTruthy();
            expect(kindIcon(kind)).toBe(lucide[name]);
        });
    }
});

describe('kindColors — kindOf, tiles and radii', () => {
    it('kindOf accepts a key, an alias, an object with kind/type/objectType, and tolerates garbage', () => {
        expect(kindOf('kb')).toBe('kb');
        expect(kindOf('knowledge_base')).toBe('kb');
        expect(kindOf('Automations')).toBe('automation');
        expect(kindOf('automation')).toBe('automation');
        expect(kindOf('tables')).toBe('datatable');
        expect(kindOf('meeting_note')).toBe('meeting');
        expect(kindOf('compliance')).toBe('compliance');
        expect(kindOf('compliance_hub')).toBe('compliance');
        expect(kindOf('gdpr')).toBe('compliance');
        expect(kindOf('privacy')).toBe('compliance');
        expect(kindOf({ kind: 'app', id: 'a1' })).toBe('app');
        expect(kindOf({ type: 'webpage' })).toBe('webpage');
        expect(kindOf({ objectType: 'skill' })).toBe('skill');
        expect(kindOf({ resourceType: 'solution' })).toBe('solution');
        expect(kindOf({ kind: 'form', type: 'agent' }), 'kind wins over type').toBe('form');
        expect(kindOf(null)).toBeNull();
        expect(kindOf('')).toBeNull();
        expect(kindOf({})).toBeNull();
        expect(kindOf('no_such_kind')).toBeNull();
        expect(kindOf(42)).toBeNull();
    });

    it('the 28px header tile uses an 18% tint and a 15px glyph; the 30px legend tile 16%; explicit pct wins', () => {
        const header = kindTileStyle('agent', { size: 28 });
        expect(header.tile.background).toBe('color-mix(in srgb, var(--type-ai) 18%, transparent)');
        expect(header.tile.width).toBe(28);
        expect(header.glyph.width).toBe(15);
        const legend = kindTileStyle('kb');
        expect(legend.tile.width).toBe(30);
        expect(legend.tile.background).toBe('color-mix(in srgb, var(--kind-kb) 16%, transparent)');
        expect(legend.tile.color).toBe('var(--kind-kb)');
        expect(legend.glyph.width).toBe(15);
        expect(kindTileStyle('kb', { size: 48, pct: 10 }).tile.background).toBe('color-mix(in srgb, var(--kind-kb) 10%, transparent)');
        expect(kindTileStyle('kb', 36).tile.width).toBe(36);
        expect(kindTileStyle('kb', 48).glyph.width).toBe(24);
    });

    it('shapes: an automation is trigger-shaped, a form is a circle, everything else an 8px tile', () => {
        expect(kindTileStyle('automation').tile.borderRadius).toBe('15px 8px 8px 15px');
        expect(kindTileStyle('automation', { size: 48 }).tile.borderRadius).toBe('24px 8px 8px 24px');
        expect(kindTileStyle('form').tile.borderRadius).toBe('999px');
        expect(kindTileStyle('app').tile.borderRadius).toBe('8px');
        expect(kindTileStyle('solution').tile.borderRadius).toBe('8px');
    });

    it('cardRadius matches the artboard legend', () => {
        expect(cardRadius('automation')).toBe('15px 8px 8px 15px');
        expect(cardRadius('form')).toBe('999px');
        expect(cardRadius('meeting')).toBe('8px');
        expect(cardRadius('nope')).toBe('8px');
    });
});
