/**
 * DIFFERENTIAL lockstep: family colours, tiles and card chrome against the
 * web's flow/nodeTypeColors.js.
 *
 * The web answers in CSS (`var(--type-ai)`, `color-mix(…)`, `1.5px solid …`);
 * the phone answers with theme values. So the port runs on a theme whose
 * every colour IS the web's CSS variable, with `tint` spelled as the web's
 * color-mix — and then the two can be compared string for string.
 */

import { WEB_TOKENS } from '@/core/theme/generated/webTokens.generated';
import type { Theme } from '@/core/theme/types';

import * as fs from './familyStyle';
import { NODE_FAMILIES, NODE_TYPE_KEYS } from './nodeDefs';

jest.mock('lucide-react', () => new Proxy({}, { get: (_t, name) => (name === '__esModule' ? false : String(name)) }), { virtual: true });
jest.mock('@/shared/ui/tint', () => ({ tint: (c: string, p: number) => `color-mix(in srgb, ${c} ${p}%, transparent)` }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const web = require('../../../../../agent-hub/src/components/automation/Builder/flow/nodeTypeColors.js');

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const CSS_THEME = {
    colors: new Proxy({}, { get: (_t, key) => (key === 'typeAi' ? 'var(--type-ai)' : `var(--${kebab(String(key))})`) }),
    stepType: Object.fromEntries(NODE_FAMILIES.map((f) => [f, `var(--type-${f})`])),
} as unknown as Pick<Theme, 'colors' | 'stepType'>;

const GROUPS = [...NODE_FAMILIES, null, undefined, 'nope'];
const STATUSES = [...fs.CANVAS_STATUSES, 'failed', 'info', 'edited', 'nothing_to_do', 'warning', 'idle', 'paused_breakpoint', 'SUCCESS', 'bogus', 'constructor', null];

/** The port's chrome, written the way the web writes its style. */
function asWebStyle(c: fs.CardChrome) {
    return {
        border: `${c.borderWidth}px ${c.borderStyle} ${c.borderColor}`,
        radius: c.roundedEdge,
        bar: c.bar,
        ring: c.ring,
        opacity: c.opacity,
        pulse: c.pulse,
        badge: c.badge,
    };
}

function readWebStyle({ style, badge }: { style: Record<string, unknown>; badge: unknown }) {
    const radius = String(style.borderRadius);
    const parts = String(style.boxShadow).split(/, (?=inset |var\(--shadow|0 0 0 4px)/);
    const rings = parts.filter((p) => p.startsWith('0 0 0 4px')).map((p) => p.replace('0 0 0 4px ', ''));
    return {
        border: style.border,
        radius: radius.startsWith('36px') ? 'leading' : radius.endsWith('var(--radius-md)') && radius.includes('36px') ? 'trailing' : null,
        bar: (parts[0] as string).replace('inset 4px 0 0 ', ''),
        ring: rings.length ? rings[rings.length - 1] : null,
        opacity: style.opacity,
        pulse: !!style.animation,
        badge,
    };
}

describe('families', () => {
    it.each(GROUPS.map((g) => [String(g), g] as const))('colour, tint and tile for %s', (_l, group) => {
        expect(fs.familyColor(CSS_THEME, group)).toBe(web.typeColorVar(group));
        expect(fs.familyTint(CSS_THEME, group)).toBe(web.typeTint(group));
        expect(fs.familyTint(CSS_THEME, group, 8)).toBe(web.typeTint(group, 8));
        for (const type of [null, 'form_page', 'loop_item']) {
            for (const error of [false, true]) {
                const mine = fs.typeTile(CSS_THEME, group, { type, error });
                const { tile } = web.typeTileStyle(group, { type, error });
                expect({ background: mine.background, color: mine.color }).toEqual({ background: tile.background, color: tile.color });
                const shape = tile.transform ? 'diamond' : tile.borderRadius === 999 ? 'circle' : typeof tile.borderRadius === 'string' ? 'shield' : group === 'end' ? 'block' : 'rounded';
                expect(mine.shape).toBe(shape);
            }
        }
    });

    it.each([...NODE_TYPE_KEYS, 'nope'])('typeGroupOf(%s)', (type) => {
        expect(fs.typeGroupOf(type)).toBe(web.typeGroupOf(type));
        expect(fs.typeGroupOf({ type })).toBe(web.typeGroupOf({ type }));
    });

    it('the families and the badge table are the web\'s', () => {
        expect([...fs.TYPE_GROUPS]).toEqual(web.TYPE_GROUPS);
        expect(fs.STATUS_BADGE).toEqual(web.STATUS_BADGE);
        expect([...fs.CANVAS_STATUSES]).toEqual(Object.keys(web.STATUS_VAR));
        expect(fs.typeGroupOf(null)).toBeNull();
    });

    it('every theme paints every family', () => {
        for (const tokens of Object.values(WEB_TOKENS)) {
            for (const f of NODE_FAMILIES) expect(tokens.stepType[f]).toMatch(/^#[0-9a-f]{3,8}$/i);
        }
    });
});

describe('status and chrome', () => {
    it.each(STATUSES.map((s) => [String(s), s] as const))('status %s', (status) => {
        expect(fs.statusColor(CSS_THEME, status)).toBe(web.statusVar(status));
        for (const g of GROUPS) expect(fs.miniMapColor(CSS_THEME, g, status)).toBe(web.miniMapColor(g, status));
    });

    const INPUTS = GROUPS.flatMap((group) =>
        [null, 'running', 'error', 'skipped', 'queued', 'awaiting_form'].flatMap((status) => [
            { group, status },
            { group, status, type: 'loop_item' },
            { group, status, pinned: true },
            { group, status, disabled: true },
            { group, status, selected: true, error: true },
            { group, status, pinned: true, selected: true },
        ]),
    );
    it('cardChrome agrees for every family × status × flag', () => {
        for (const input of INPUTS) {
            expect({ input, out: asWebStyle(fs.cardChrome(CSS_THEME, input)) }).toEqual({ input, out: readWebStyle(web.cardChrome(input)) });
        }
    });
});
