import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NODE_DEFS, NODE_TYPE_KEYS, NODE_FAMILIES, FAMILY_EXEMPT, stepFamily } from './nodeDefs';
import {
    TYPE_GROUPS, typeGroupOf, typeColorVar, typeTint, typeTileStyle, cardChrome, cardRadius,
    STATUS_VAR, STATUS_BADGE, statusVar, miniMapColor, CARD_W, CARD_H,
} from './nodeTypeColors';
import { STATUS_TOKENS, tokenFor } from '../../../shared/statusTokens';

/**
 * The completeness net for the SIXTH per-type map in the builder.
 *
 * nodeDefs.test.js exists because every per-type map that forgot a step type
 * failed quietly behind a "reasonable" fallback. A colour map fails the same
 * way — the forgotten type simply renders grey — so this file proves, for
 * every renderable type, that it names a family, that every family is used,
 * and that every CSS variable the module emits is actually declared in
 * src/index.css (an undeclared var() paints NOTHING, in every theme).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_CSS = fs.readFileSync(path.resolve(HERE, '../../../../index.css'), 'utf8');
const SELF = fs.readFileSync(path.join(HERE, 'nodeTypeColors.js'), 'utf8');

const declared = new Set([...INDEX_CSS.matchAll(/(--[a-z0-9-]+)\s*:/g)].map(m => m[1]));

describe('nodeTypeColors — every step type has a family', () => {
    for (const type of NODE_TYPE_KEYS) {
        it(`${type} names a family or is exempted with a reason`, () => {
            const fam = stepFamily(type);
            if (fam === null) {
                expect(FAMILY_EXEMPT[type], `${type} has no family and no exemption`).toBeTruthy();
                expect(FAMILY_EXEMPT[type].length, `${type}: give a real reason`).toBeGreaterThan(10);
                return;
            }
            expect(NODE_FAMILIES, `${type}: ${fam} is not a known family`).toContain(fam);
        });
    }

    it('every family is used by at least one type (a dead family is a design that drifted)', () => {
        const used = new Set(NODE_TYPE_KEYS.map(stepFamily).filter(Boolean));
        for (const fam of NODE_FAMILIES) expect(used.has(fam), `family ${fam} is used by no type`).toBe(true);
    });

    it('every exemption names a real record that really has family: null', () => {
        for (const type of Object.keys(FAMILY_EXEMPT)) {
            expect(NODE_DEFS[type], `${type} is exempted but has no record`).toBeTruthy();
            expect(NODE_DEFS[type].family, `${type} is exempted yet names a family`).toBeNull();
        }
    });

    it('typeGroupOf accepts a step or a bare type, and tolerates garbage', () => {
        expect(typeGroupOf('ai_step')).toBe('ai');
        expect(typeGroupOf({ type: 'ai_step', id: 's1' })).toBe('ai');
        expect(typeGroupOf(null)).toBeNull();
        expect(typeGroupOf('no_such_type')).toBeNull();
        expect(TYPE_GROUPS).toBe(NODE_FAMILIES);
    });

    it('the list steps are data, Flatten a list included', () => {
        for (const type of ['limit', 'dedupe', 'aggregate', 'summarize', 'flatten']) expect(stepFamily(type), type).toBe('data');
    });

    it('the families the design draws are the families the code knows', () => {
        // Editor.dc.html TYPES + the ribbon in artboard 1f.
        expect([...NODE_FAMILIES].sort()).toEqual(['ai', 'app', 'branch', 'data', 'end', 'guard', 'loop', 'pause', 'trigger']);
    });
});

describe('nodeTypeColors — every variable it emits is declared in src/index.css', () => {
    it('the module names only declared custom properties', () => {
        const missing = new Set();
        for (const m of SELF.matchAll(/var\((--[a-z0-9-]+)/g)) {
            // `var(--type-${group})` in the source is a template stub, not a
            // token name — the family tokens are checked one by one below.
            if (m[1].endsWith('-')) continue;
            if (!declared.has(m[1])) missing.add(m[1]);
        }
        expect([...missing]).toEqual([]);
    });

    it('every family token is declared in BOTH the dark and the light set', () => {
        const dark = INDEX_CSS.match(/:root,\n\[data-theme="glass-dark"\],\n\[data-theme="obsidian"\] \{[^}]*--type-trigger[^}]*\}/);
        const light = INDEX_CSS.match(/\[data-theme="light"\],\n\[data-theme="glass"\],\n\[data-theme="high-contrast"\],\n\[data-theme="paper"\],\n\[data-theme="sepia"\] \{[^}]*--type-trigger[^}]*\}/);
        expect(dark, 'dark --type-* block').toBeTruthy();
        expect(light, 'light --type-* block').toBeTruthy();
        for (const fam of NODE_FAMILIES) {
            if (fam === 'end') continue; // aliased to the theme ink once, in :root
            expect(dark[0], `dark set lacks --type-${fam}`).toContain(`--type-${fam}:`);
            expect(light[0], `light set lacks --type-${fam}`).toContain(`--type-${fam}:`);
        }
        expect(INDEX_CSS).toContain('--type-end: var(--text-primary)');
    });

    it('--pinned is declared in every one of the eight theme blocks, like --error is', () => {
        const errors = INDEX_CSS.match(/^ {4}--error: #/gm) || [];
        const pinned = INDEX_CSS.match(/^ {4}--pinned: #/gm) || [];
        expect(errors.length).toBe(8);
        expect(pinned.length).toBe(8);
    });

    it('the running pulse keyframe exists and animates only outline-color', () => {
        const start = INDEX_CSS.indexOf('@keyframes bf-node-pulse');
        expect(start).toBeGreaterThan(0);
        const body = INDEX_CSS.slice(start, INDEX_CSS.indexOf('@keyframes', start + 10));
        expect(body).toContain('outline-color');
        expect(body).not.toMatch(/width|height|margin|padding|top:|left:/);
        // The COLOUR is the card's to choose: cardChrome hands the keyframe
        // --bf-pulse-color, the same token it gives the border. A keyframe
        // that names a status colour itself is a second opinion, and since
        // outline-color beats the shorthand it is the opinion that wins —
        // which is how the pulse stayed amber the day running turned blue.
        expect(body).toContain('var(--bf-pulse-color');
        expect(body).not.toContain('var(--warning)');
    });

    it('emits no hex and never leans on the grey --accent', () => {
        // `#fff` on a solid badge/tile is the one literal allowed: white on a
        // saturated status colour or the theme ink. `#9ca3af` appears only in
        // the header comment that explains why --accent is banned here.
        const hexes = [...SELF.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(m => m[0]).filter(h => h !== '#fff' && h !== '#9ca3af');
        expect(hexes).toEqual([]);
        expect(SELF).not.toMatch(/var\(--accent\)/);
        expect(SELF).not.toMatch(/var\(--accent-primary\)/);
    });
});

describe('nodeTypeColors — status beats type', () => {
    const RUN_STATUSES = ['success', 'error', 'running', 'skipped', 'handled_error', 'awaiting_approval', 'awaiting_confirm', 'awaiting_form', 'cancelled', 'pinned'];

    it('covers every status the canvas can receive (the old StepNodeBase ladder + the runStatus pin stub)', () => {
        for (const s of RUN_STATUSES) expect(s in STATUS_VAR, `STATUS_VAR lacks ${s}`).toBe(true);
    });

    for (const s of RUN_STATUSES.filter(s => STATUS_VAR[s])) {
        it(`${s}: the border and ring carry the status colour, the bar keeps the family colour`, () => {
            const { style } = cardChrome({ group: 'ai', status: s });
            expect(style.border).toContain(STATUS_VAR[s]);
            expect(style.boxShadow).toContain('inset 4px 0 0 var(--type-ai)');
            expect(style.boxShadow).toContain(`0 0 0 4px color-mix(in srgb, ${STATUS_VAR[s]} 22%, transparent)`);
        });
    }

    it('a neutral status keeps the neutral border', () => {
        for (const s of ['skipped', 'cancelled', 'queued']) {
            const { style, badge } = cardChrome({ group: 'data', status: s });
            expect(style.border).not.toMatch(/var\(--(success|error|warning|pinned)\)/);
            expect(badge).toBeNull();
        }
    });

    it('running adds the pulsing outline on top of the ring', () => {
        const { style } = cardChrome({ group: 'pause', status: 'running' });
        expect(style.outline).toBe(`3px solid ${STATUS_VAR.running}`);
        expect(style.outlineOffset).toBe(3);
        expect(style.animation).toContain('bf-node-pulse');
    });

    it('selection beats status; disabled dashes and fades', () => {
        const sel = cardChrome({ group: 'ai', status: 'error', selected: true });
        expect(sel.style.border).toBe('2px solid var(--text-primary)');
        const dis = cardChrome({ group: 'ai', disabled: true });
        expect(dis.style.border).toBe('1px dashed var(--text-tertiary)');
        expect(dis.style.opacity).toBe(0.55);
    });

    it('an idle pinned card reads as pinned; a live run status outranks the pin', () => {
        expect(cardChrome({ group: 'ai', pinned: true }).badge.en).toBe('pinned');
        expect(cardChrome({ group: 'ai', pinned: true, status: 'running' }).badge.en).toBe('running');
    });

    it('badges exist for every visible status and carry an i18n key', () => {
        for (const s of Object.keys(STATUS_VAR).filter(s => STATUS_VAR[s])) {
            expect(STATUS_BADGE[s], `no badge for ${s}`).toBeTruthy();
            expect(STATUS_BADGE[s].key).toMatch(/^automations\.card\.badge_/);
        }
    });

    it('a loop card is dashed in its own colour until a status paints it solid', () => {
        expect(cardChrome({ group: 'loop', type: 'loop' }).style.border).toBe('1.5px dashed var(--type-loop)');
        expect(cardChrome({ group: 'loop', type: 'loop', status: 'success' }).style.border).toBe('1.5px solid var(--success)');
    });

    it('an error end card (Stop with an error) paints its bar and tile red, not ink', () => {
        expect(cardChrome({ group: 'end', error: true }).style.boxShadow).toContain('inset 4px 0 0 var(--error)');
        expect(typeTileStyle('end', { error: true }).tile.background).toBe('var(--error)');
    });
});

describe('nodeTypeColors — the canvas reads the shared status table', () => {
    /**
     * What this file missed the first time round. The canvas kept its own
     * status→colour ladder, so `running` stayed amber here while the run
     * panel and the inspector's Run tab moved to blue — and those are not
     * separate screens: RunExecutionView renders the DiagramPane whose cards
     * this module paints, so one view showed a blue step icon beside an amber
     * node. Worse, the amber was the SAME amber as `paused`, which is CW-04
     * itself: "doing work right now" and "deliberately switched off" in one
     * colour. Pinning values here would only have made the drift official —
     * so what is pinned is that the values come from somewhere else.
     */
    it('takes every colour from statusTokens, server spellings included', () => {
        for (const [status, value] of Object.entries(STATUS_VAR)) {
            expect(value, status).toBe(tokenFor(status).cssVar);
        }
        // The alias really resolves rather than quietly landing on `idle`:
        // the runner records awaiting_confirm, the table knows awaiting_approval.
        expect(STATUS_VAR.awaiting_confirm).toBe(STATUS_TOKENS.awaiting_approval.cssVar);
        expect(STATUS_VAR.awaiting_confirm).toBe('var(--warning)');
    });

    it('never paints running and paused in one colour again', () => {
        expect(STATUS_VAR.running).toBe('var(--type-ai)');
        expect(STATUS_VAR.running).not.toContain('--warning');
        expect(STATUS_VAR.running).not.toBe(STATUS_VAR.paused);
        // `paused` is neutral now: no chrome, and therefore no badge to sit
        // in a colour it no longer has. Same treatment queued and cancelled
        // already had — a state that is not a problem makes no claim.
        expect(STATUS_VAR.paused).toBeNull();
        expect(STATUS_BADGE.paused).toBeUndefined();
    });

    it('pulses in the colour it borders with, and says so to the stylesheet', () => {
        const { style } = cardChrome({ group: 'ai', status: 'running' });
        expect(style.border).toBe(`1.5px solid ${STATUS_VAR.running}`);
        expect(style.outline).toBe(`3px solid ${STATUS_VAR.running}`);
        expect(style['--bf-pulse-color']).toBe(STATUS_VAR.running);
    });

    it('gives an unknown status no chrome instead of inventing some', () => {
        // Including the words every object literal answers to: `STATUS_VAR
        // ['constructor']` is a function, and a border painted with one is
        // not a border. statusVar goes through tokenFor, which owns that guard.
        for (const s of ['weird_future_status', 'constructor', '__proto__', 'toString']) {
            expect(statusVar(s), s).toBeNull();
            const { style, badge } = cardChrome({ group: 'ai', status: s });
            expect(style.border, s).toBe('1px solid var(--border-default)');
            expect(badge, s).toBeNull();
        }
        expect(statusVar(null)).toBeNull();
        expect(statusVar(undefined)).toBeNull();
    });
});

describe('nodeTypeColors — tiles, radii, minimap', () => {
    it('the four special tile shapes', () => {
        expect(typeTileStyle('pause', { type: 'form_page' }).tile.borderRadius).toBe(999);
        expect(typeTileStyle('pause', { type: 'approval' }).tile.borderRadius).toBe(9);
        expect(typeTileStyle('guard').tile.borderRadius).toBe('8px 8px 50% 50%');
        const branch = typeTileStyle('branch');
        expect(branch.tile.transform).toContain('rotate(45deg)');
        expect(branch.glyph.transform).toBe('rotate(-45deg)');
        const end = typeTileStyle('end');
        expect(end.tile.background).toBe('var(--text-primary)');
        expect(end.tile.color).toBe('var(--bg-primary)');
        expect(typeTileStyle('ai').tile.borderRadius).toBe(9);
    });

    it('trigger and end cards round their outer corners; everything else uses --radius-md', () => {
        // Design: trigger 36/12/12/36, end 12/36/36/12 (TL TR BR BL).
        expect(cardRadius('trigger')).toBe('36px var(--radius-md) var(--radius-md) 36px');
        expect(cardRadius('end')).toBe('var(--radius-md) 36px 36px var(--radius-md)');
        expect(cardRadius('ai')).toBe('var(--radius-md)');
    });

    it('typeColorVar / typeTint never leak a hex, and fall back to an ink for no family', () => {
        expect(typeColorVar('ai')).toBe('var(--type-ai)');
        expect(typeColorVar(null)).toBe('var(--text-tertiary)');
        expect(typeColorVar('nope')).toBe('var(--text-tertiary)');
        expect(typeTint('loop')).toBe('color-mix(in srgb, var(--type-loop) 18%, transparent)');
    });

    it('the minimap swatch is the status colour when there is one, else the family', () => {
        expect(miniMapColor('ai')).toBe('var(--type-ai)');
        expect(miniMapColor('ai', 'error')).toBe('var(--error)');
        expect(miniMapColor('ai', 'skipped')).toBe('var(--type-ai)');
    });

    it('card geometry matches the design (240×72; the 96px layout box adds the tool port)', () => {
        expect(CARD_W).toBe(240);
        expect(CARD_H).toBe(72);
    });
});
