// @typecheck strict
'use strict';

/** @type {Record<string, { accent: string, ink: string, font: string, fontSize: number, lineHeight: number, margin: number }>} */
const PRESETS = {
    neutral: { accent: '#334155', ink: '#172033', font: 'sans', fontSize: 11, lineHeight: 1.5, margin: 18 },
    branded: { accent: '#d97706', ink: '#172033', font: 'sans', fontSize: 11, lineHeight: 1.6, margin: 18 },
    formal: { accent: '#1e3a5f', ink: '#172033', font: 'serif', fontSize: 12, lineHeight: 1.6, margin: 22 },
};
/**
 * @param {{ preset?: string, accent?: string, ink?: string, font?: string, pageSize?: string, margin?: number, fontSize?: number,
 *   lineHeight?: number, logoWidth?: number, logoPosition?: string, showHeader?: boolean, showFooter?: boolean }} [design]
 */
const FONTS = /** @type {Record<string, string>} */ ({ sans: 'Arial, sans-serif', serif: 'Georgia, serif', mono: 'monospace' });
// nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- anchored with bounded counts: linear
const isHex = (/** @type {unknown} */ v) => typeof v === 'string' && /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(v);
const num = (/** @type {unknown} */ v, /** @type {number} */ min, /** @type {number} */ max, /** @type {number} */ fallback) => Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : fallback;

/**
 * The --doc-* variables this document chose itself; the rest stay the house style's (or the base sheet's).
 * A choice is a preset other than neutral, or a value set by hand. Older clients stored the whole neutral
 * preset with every edit, so a neutral value under the neutral preset is no choice either.
 * @param {Record<string, unknown>} design
 * @param {Record<string, unknown> | undefined} preset
 */
function chosenVars(design, preset) {
    /** @param {'accent'|'ink'|'font'} key */
    const chosen = (key) => {
        const v = design[key];
        if (v === undefined || v === null || v === '') return preset?.[key];
        return !preset && v === PRESETS.neutral[key] ? undefined : v;
    };
    const accent = chosen('accent'); const ink = chosen('ink'); const font = chosen('font');
    return [
        isHex(accent) ? `--doc-accent:${accent};` : '',
        isHex(ink) ? `--doc-ink:${ink};` : '',
        font ? `--doc-font:${FONTS[String(font)] || FONTS.sans};` : '',
    ].filter(Boolean);
}

/**
 * @param {{ preset?: string, accent?: string, ink?: string, font?: string, pageSize?: string, margin?: number, fontSize?: number,
 *   lineHeight?: number, logoWidth?: number, logoPosition?: string, showHeader?: boolean, showFooter?: boolean }} [design]
 */
function designCss(design = {}) {
    const preset = design.preset && design.preset !== 'neutral' ? PRESETS[design.preset] : undefined;
    const d = { ...PRESETS.neutral, ...preset, ...design };
    const vars = chosenVars(design, preset);
    const letter = d.pageSize === 'Letter';
    // The house style sizes the logo unless this document did.
    const logoWidth = design.logoWidth === undefined ? '' : `width:${num(design.logoWidth, 10, 80, 24)}mm; `;
    const left = d.logoPosition === 'right' || d.logoPosition === 'center' ? 'auto' : '0';
    return `${vars.length ? `:root { ${vars.join(' ')} }\n` : ''}@page { size:${letter ? 'Letter' : 'A4'}; margin:${num(d.margin, 0, 40, 18)}mm; }
body { font-family:var(--doc-font); color:var(--doc-ink); font-size:${num(d.fontSize, 8, 24, 11)}pt; line-height:${num(d.lineHeight, 1, 2.5, 1.5)}; }
@media screen { body { width:${letter ? '215.9' : '210'}mm; padding:${num(d.margin, 0, 40, 18)}mm; } }
h1,h2,h3 { color:var(--doc-accent); }
.doc-logo { ${logoWidth}margin-left:${left}; margin-right:${d.logoPosition === 'center' ? 'auto' : '0'}; }
.doc-header { display:${d.showHeader === false ? 'none' : 'block'}; }
.doc-footer { display:${d.showFooter === false ? 'none' : 'block'}; }`;
}
module.exports = { PRESETS, designCss };
