// @typecheck strict
/**
 * The design DOCUMENT of the design phase (designPhase.js): the model's
 * answer clamped to the shape the stage draws (normaliseDesign), and that
 * document rendered in the app builder's own vocabulary for the app brief
 * (designToBrief). The caps and the designer's vocabulary (presets, element
 * kinds) live here; designPhase re-exports what its callers import.
 */

'use strict';

const { copyFor } = require('../copy');
// The brief is cut at whole lines, by the helper the document writer uses.
// recipeDoc requires only copy.js and the data model, so there is no cycle
// back to here.
const { clampToLines } = require('../recipeDoc');
const { describeScreenConstraints } = require('../../core/llm/screenConstraints');
const log = require('../../telemetry/log');

const PRESETS = ['classic', 'cloud', 'atlas', 'midnight', 'field', 'paper', 'mono'];
const ELEMENT_KINDS = ['stat', 'chart', 'table', 'filters', 'form', 'detail', 'list', 'text', 'button', 'image'];
const SECTION_LAYOUTS = ['row', 'grid', 'stack', 'split'];
const MAX_SCREENS = 6;
const MAX_SECTIONS = 6;
const MAX_ELEMENTS = 8;
// Raised from 1600 with the move to markdown (2026-09-16): a heading per
// screen and a bullet per section cost characters the prose version did not.
const MAX_DESIGN_BRIEF_CHARS = 1800;

/**
 * @typedef {{ kind?: string, label?: unknown, note?: unknown }} RawElement
 * @typedef {{ title?: unknown, layout?: string, elements?: Array<RawElement | null> }} RawSection
 * @typedef {{ name?: unknown, purpose?: unknown, sections?: Array<RawSection | null> }} RawScreen
 * @typedef {{ preset?: string, accent?: unknown, mood?: unknown }} RawLook
 * @typedef {{ name?: unknown, tagline?: unknown, look?: RawLook, screens?: Array<RawScreen | null>, principles?: unknown[] }} RawDesign
 *   The `return_design` tool's arguments as the model sent them (parsed JSON, unchecked).
 * @typedef {NonNullable<ReturnType<typeof import('../../core/llm/screenConstraints').deriveScreenConstraints>>} ScreenConstraints
 */

/**
 * The value when it is an array, else an empty one.
 * @template T
 * @param {T[] | null | undefined} value
 * @returns {T[]}
 */
function list(value) {
    return Array.isArray(value) ? value : [];
}

/**
 * The value when it is one of `allowed`, else the default.
 * @param {string[]} allowed
 * @param {unknown} value
 * @param {string} dflt
 * @returns {string}
 */
function oneOf(allowed, value, dflt) {
    return typeof value === 'string' && allowed.includes(value) ? value : dflt;
}

/**
 * A trimmed string capped at `n`, or '' for anything that is not a string.
 * @param {unknown} v
 * @param {number} n
 */
function str(v, n) {
    return typeof v === 'string' ? v.trim().slice(0, n) : '';
}

/**
 * Clamp the model's design to the shape the stage draws and the brief carries.
 * @param {unknown} raw
 * @param {string | null} [locale]
 */
function normaliseDesign(raw, locale = null) {
    const screenWord = copyFor(locale).screenFallback;
    const d = /** @type {RawDesign} */ (raw && typeof raw === 'object' ? raw : {});
    const look = /** @type {RawLook} */ (d.look && typeof d.look === 'object' ? d.look : {});
    const accent = /^#[0-9a-fA-F]{6}$/.test(String(look.accent || '')) ? String(look.accent).toLowerCase() : '#1e7f4f';
    const screens = list(d.screens).slice(0, MAX_SCREENS).map((s) => ({
        name: str(s && s.name, 40) || screenWord,
        purpose: str(s && s.purpose, 160),
        sections: list(s && s.sections).slice(0, MAX_SECTIONS).map((sec) => ({
            title: str(sec && sec.title, 60),
            layout: oneOf(SECTION_LAYOUTS, sec && sec.layout, 'stack'),
            elements: list(sec && sec.elements).slice(0, MAX_ELEMENTS).map((e) => ({
                kind: oneOf(ELEMENT_KINDS, e && e.kind, 'text'),
                label: str(e && e.label, 60) || '',
                note: str(e && e.note, 160),
            })).filter((e) => e.label),
        })).filter((sec) => sec.elements.length),
    })).filter((s) => s.sections.length);
    return {
        name: str(d.name, 60) || 'App',
        tagline: str(d.tagline, 120),
        look: { preset: oneOf(PRESETS, look.preset, 'cloud'), accent, mood: str(look.mood, 60) },
        screens,
        principles: list(d.principles).map((p) => str(p, 120)).filter(Boolean).slice(0, 5),
    };
}

/** @typedef {ReturnType<typeof normaliseDesign> & { constraints?: ScreenConstraints | null }} DesignDoc */

/**
 * The designer's kinds in the BUILDER's own vocabulary.
 *
 * Every value here must be a type the builder will accept verbatim, because the
 * design block tells it the design outranks the brief. `stat` must not render as
 * "stat tile", which is not a component type — an invitation to emit `stat_tile`
 * and burn a round on the refusal. Checked against the real registry by
 * `checkElementWords` — the route at load, designPhase.test.js in CI — so the
 * map cannot drift from it again.
 * @type {Record<string, string>}
 */
const ELEMENT_WORDS = {
    stat: 'stat', chart: 'chart', table: 'data_grid', filters: 'filter_bar', form: 'form', detail: 'record_detail', list: 'list', text: 'text', button: 'button', image: 'image',
};

/**
 * The map keys whose word is NOT in the builder's registry — `[]` when the map
 * is sound. The registry (appStudio/componentSpecs.COMPONENT_TYPES) is handed
 * in rather than required: playbooks/ may not require appStudio/ (one feature
 * never requires another — layering.test.js), so routes/playbooks.js, which
 * may require both, runs this at load. Warns, never throws: a stale word costs
 * the builder a round, not the server its boot.
 * @param {unknown} componentTypes
 * @returns {string[]}
 */
function checkElementWords(componentTypes) {
    const real = new Set(Array.isArray(componentTypes) ? componentTypes : []);
    if (!real.size) return [];
    const unknown = Object.entries(ELEMENT_WORDS).filter(([, word]) => !real.has(word));
    for (const [kind, word] of unknown) log.warn(`[playbooks/design] ELEMENT_WORDS.${kind} = "${word}" is not a component type the app builder knows`);
    return unknown.map(([kind]) => kind);
}

/**
 * What a section's layout means to the builder, which speaks in 12-column spans.
 * `normaliseDesign` has always kept the layout and `designToBrief` never emitted
 * it, so "four tiles across" — the thing the room just approved — arrived as a
 * default stack.
 * @type {Record<string, string>}
 */
const LAYOUT_SPAN = { row: '3 columns each', grid: '6 columns each', split: '8 and 4 columns', stack: 'full width' };

/**
 * The design as the BUILDER reads it: the same screens and elements in the
 * builder's component words, capped so the app brief stays small. This is
 * appended to the app phase's brief.
 * @param {DesignDoc | null | undefined} design
 * @returns {string}
 */
function designToBrief(design) {
    if (!design || !Array.isArray(design.screens) || !design.screens.length) return '';
    const lines = [
        '## DESIGN',
        `Follow this; where it differs from the screens above, THIS wins. Call \`app_set_theme {preset:"${design.look.preset}", primary:"${design.look.accent}"}\` first${design.look.mood ? ` — mood: ${design.look.mood}` : ''}.`,
        '',
    ];
    for (const s of design.screens) {
        lines.push(`### Screen "${s.name}"${s.purpose ? ` — ${s.purpose}` : ''}`);
        for (const sec of s.sections) {
            const els = sec.elements.map((e) => `${ELEMENT_WORDS[e.kind] || e.kind} "${e.label}"${e.note ? ` (${e.note})` : ''}`).join(', ');
            const span = LAYOUT_SPAN[sec.layout] || LAYOUT_SPAN.stack;
            lines.push(`- ${sec.title ? `**${sec.title}**: ` : ''}${els} — ${span}`);
        }
    }
    if (design.principles && design.principles.length) lines.push('', `**Principles:** ${design.principles.join('; ')}.`);
    // The person's screen intent, once more for the builder: the design above
    // already complies, and the builder must not add the screen back on its own.
    const constraintLine = describeScreenConstraints(design.constraints ?? null);
    if (constraintLine) lines.push('', `**${constraintLine}**`);
    let text = lines.join('\n');
    // Whole lines, never a character cut: the block must not end mid-bullet or
    // mid-"**Principles:**", and the builder is told THIS outranks the brief.
    if (text.length > MAX_DESIGN_BRIEF_CHARS) text = clampToLines(text, MAX_DESIGN_BRIEF_CHARS);
    return text;
}

module.exports = {
    normaliseDesign, designToBrief, checkElementWords,
    PRESETS, ELEMENT_KINDS, ELEMENT_WORDS, MAX_SECTIONS, MAX_DESIGN_BRIEF_CHARS,
};
