/**
 * App Studio builder: the `design` of a build plan (app_propose_plan).
 *
 * The look the model intends to build, shown in the plan card so the user approves it with the
 * tables and screens: a direction sentence, the preset it starts from (or "custom"), the primary
 * colour, the typeface, the navigation style, the surface and up to three signature moves.
 *
 * A plan is presented and stored, never executed, so this only bounds it: text is capped, and a
 * value that names something app_set_theme would not take (an unknown preset, a colour that is
 * not #rrggbb) is dropped instead of shown as if it were a choice. The whole key is absent when
 * nothing usable was sent, so a plan without a design is the plan it always was.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { capStr, capStrArray } = nodeRequire('./shared.js') as {
    capStr: (v: unknown, max: number) => string | undefined;
    capStrArray: (v: unknown, maxItems: number, maxLen: number) => string[] | undefined;
};
const { DESIGN_SPEC, NAV_STYLES } = nodeRequire('../componentSpecs.js') as {
    DESIGN_SPEC: Record<string, { values?: readonly string[] }>;
    NAV_STYLES: readonly string[];
};

export const PLAN_DESIGN_LIMITS = Object.freeze({ DIRECTION: 200, MOVE: 140, MAX_MOVES: 3 });

export interface PlanDesign {
    direction?: string;
    preset?: string;
    primary?: string;
    font?: string;
    navStyle?: string;
    surface?: string;
    signatureMoves?: string[];
}

const HEX_DIGITS = '0123456789abcdefABCDEF';

/** "#rrggbb", upper-cased, or undefined. */
export function hexColour(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const text = value.trim();
    if (text.length !== 7 || text[0] !== '#') return undefined;
    for (const ch of text.slice(1)) if (!HEX_DIGITS.includes(ch)) return undefined;
    return text.toUpperCase();
}

/** `value` when it is one of `allowed` (compared lower-case), else undefined. */
function oneOf(value: unknown, allowed: readonly string[]): string | undefined {
    if (typeof value !== 'string') return undefined;
    const text = value.trim().toLowerCase();
    return allowed.includes(text) ? text : undefined;
}

/** The bounded design, or undefined when there is nothing to show. */
export function boundPlanDesign(raw: unknown): PlanDesign | undefined {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const input = raw as Record<string, unknown>;
    const L = PLAN_DESIGN_LIMITS;
    const design: PlanDesign = {};
    const direction = capStr(input.direction, L.DIRECTION);
    if (direction) design.direction = direction;
    const preset = oneOf(input.preset, DESIGN_SPEC.preset.values || []);
    if (preset) design.preset = preset;
    const primary = hexColour(input.primary);
    if (primary) design.primary = primary;
    const font = oneOf(input.font, DESIGN_SPEC.font.values || []);
    if (font) design.font = font;
    const navStyle = oneOf(input.navStyle, NAV_STYLES);
    if (navStyle) design.navStyle = navStyle;
    const surface = oneOf(input.surface, DESIGN_SPEC.surface.values || []);
    if (surface) design.surface = surface;
    const moves = capStrArray(input.signatureMoves, L.MAX_MOVES, L.MOVE);
    if (moves) design.signatureMoves = moves;
    return Object.keys(design).length ? design : undefined;
}
