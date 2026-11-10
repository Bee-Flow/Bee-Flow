/**
 * The look of a draft, read back to the builder AI in the per-turn draft message
 * (builderPrompt.js renderDraftState). Everything here is emit-when-non-default: a node,
 * section, theme or design that only carries defaults renders exactly as it did before
 * this file existed, so the byte-pinned draft fixtures stay equal and the one message the
 * prefix cache never covers grows only by what the author actually changed.
 *
 *   node    `look=pills` (a `look`/`…Look` prop off its default) and
 *           `style{size=lg,border=subtle}` (style knobs off the type's defaultStyle, else
 *           off the knob's own default; `span` already has its own bit)
 *   section `style{height=fill}` for the knobs the section line does not already show
 *   theme   ` accent=#… canvas=#…`: the optional theme keys, when set
 *   design  `design preset=midnight font=inter …`: one line, only when a key is off its default
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

interface KnobSpec { default?: unknown }
interface PropSpec { default?: unknown }
interface TypeSpec { props?: Record<string, PropSpec>; defaultStyle?: Record<string, unknown> }
interface ThemeKeySpec { optional?: boolean; default?: unknown }
interface Specs {
    STYLE_KNOBS: Record<string, KnobSpec>;
    COMPONENT_SPECS: Record<string, TypeSpec>;
    SECTION_STYLE_DEFAULTS: Record<string, unknown>;
    THEME_SPEC: Record<string, ThemeKeySpec>;
    DESIGN_SPEC: Record<string, KnobSpec>;
}
type Bag = Record<string, unknown>;
export interface LookNode { type?: unknown; props?: Bag | null; style?: Bag | null }

/** Lazy: componentSpecs pulls the whole catalogue; a caller that never renders a draft pays nothing. */
function specs(): Specs {
    return nodeRequire('../componentSpecs') as Specs;
}

/** Keys the section line already prints (`padding= gap= bg=`). */
const SECTION_SHOWN = new Set(['padding', 'gap', 'background']);
const MAX_VALUE = 40;
/** A plain token may be a little longer: an `asset:<uuid>` ref (42 characters) stays whole and usable. */
const MAX_TOKEN = 48;
const TOKEN_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#._:%-';

function isObject(v: unknown): v is Bag {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

function sameValue(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

/** A short token as is; anything else quoted and cut, so one value never floods the line. */
function plainToken(s: string): boolean {
    if (!s || s.length > MAX_TOKEN) return false;
    for (const ch of s) if (!TOKEN_CHARS.includes(ch)) return false;
    return true;
}

export function lookValue(v: unknown): string {
    if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v);
    const text = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v) ?? ''; } catch { return ''; } })();
    if (typeof v === 'string' && plainToken(text)) return text;
    return JSON.stringify(text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE)}…` : text);
}

/** `k=v` for every entry of `style` that differs from its baseline, in the style's own key order. */
function offDefault(style: Bag, baseline: (key: string) => unknown, skip: (key: string) => boolean): string[] {
    const out: string[] = [];
    for (const [key, value] of Object.entries(style)) {
        if (skip(key) || value === undefined) continue;
        if (sameValue(value, baseline(key))) continue;
        out.push(`${key}=${lookValue(value)}`);
    }
    return out;
}

function knobDefault(key: string): unknown {
    const knob = specs().STYLE_KNOBS[key];
    return knob && Object.prototype.hasOwnProperty.call(knob, 'default') ? knob.default : null;
}

/** The look bits of one component line: `look=…` props and the non-default knobs. */
export function nodeLookBits(node: LookNode): string[] {
    const type = typeof node?.type === 'string' ? specs().COMPONENT_SPECS[node.type] : undefined;
    const bits: string[] = [];
    const props = isObject(node?.props) ? node.props : {};
    for (const [key, value] of Object.entries(props)) {
        if (key !== 'look' && !key.endsWith('Look')) continue;
        if (value === undefined || value === null) continue;
        const spec = type?.props?.[key];
        if (spec && sameValue(value, spec.default)) continue;
        bits.push(`${key}=${lookValue(value)}`);
    }
    const style = isObject(node?.style) ? node.style : null;
    if (style) {
        const defaults = isObject(type?.defaultStyle) ? type.defaultStyle : {};
        const knobs = offDefault(
            style,
            (key) => (Object.prototype.hasOwnProperty.call(defaults, key) ? defaults[key] : knobDefault(key)),
            (key) => key === 'span',
        );
        if (knobs.length) bits.push(`style{${knobs.join(',')}}`);
    }
    return bits;
}

/** ` style{…}` for a section's non-default knobs beyond padding/gap/bg, or ''. */
export function sectionLookSuffix(style: unknown): string {
    if (!isObject(style)) return '';
    const defaults = specs().SECTION_STYLE_DEFAULTS || {};
    const knobs = offDefault(
        style,
        (key) => (Object.prototype.hasOwnProperty.call(defaults, key) ? defaults[key] : knobDefault(key)),
        (key) => SECTION_SHOWN.has(key),
    );
    return knobs.length ? ` style{${knobs.join(',')}}` : '';
}

/** ` accent=#… canvas=#…`: every optional theme key that is set, or ''. */
export function themeLookSuffix(theme: unknown): string {
    if (!isObject(theme)) return '';
    const out: string[] = [];
    for (const [key, spec] of Object.entries(specs().THEME_SPEC)) {
        if (!spec || spec.optional !== true) continue;
        const value = theme[key];
        if (value === undefined || value === null || sameValue(value, spec.default)) continue;
        out.push(`${key}=${lookValue(value)}`);
    }
    return out.length ? ` ${out.join(' ')}` : '';
}

/** `design k=v …` for the design keys off their default (a key outside the spec always counts), or null. */
export function designLine(design: unknown): string | null {
    if (!isObject(design)) return null;
    const spec = specs().DESIGN_SPEC;
    const bits = offDefault(
        design,
        (key) => (spec[key] && Object.prototype.hasOwnProperty.call(spec[key], 'default') ? spec[key].default : null),
        () => false,
    );
    return bits.length ? `design ${bits.join(' ')}` : null;
}
