// The style rule that carries one block's colour overrides (block.style.colorOverrides).
// Moved out of ProductWebsite.tsx so it can be tested on its own.

import { cleanColorOverrides } from './blockStyleEnums.generated.mjs';
import type { BlockStyle } from './ProductWebsite.types';

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-';

/** `id` as the text of a CSS string: '"' left out, other characters outside ID_CHARS hex-escaped. */
function selectorString(id: string): string {
    let out = '';
    for (const ch of id) {
        if (ch === '"') continue;
        out += ID_CHARS.includes(ch) ? ch : `\\${(ch.codePointAt(0) ?? 0).toString(16)} `;
    }
    return out;
}

// Build a CSS rule string that scopes color-token overrides to a single
// block's wrapper via [data-cms-block-id="..."]. Returns null when there's
// nothing to override (so the rendered <style> stays empty).
//
// CSS custom properties resolve var() references at the point of declaration,
// not the point of use. marketing.css declares aliases like
//   .marketing-root { --accent: var(--brand-primary); --bg-primary: var(--brand-bg); … }
// which get computed ON .marketing-root using ITS --brand-* values. Setting
// --brand-primary on a deeper wrapper would NOT change those aliases for
// descendants, because the alias values were already baked at the
// marketing-root level. Most section CSS uses the aliases, not the raw
// --brand-* tokens, so a naked --brand-* override would be near-invisible.
//
// To fix: re-declare the alias chain at the wrapper level too, so it
// re-evaluates against whatever --brand-* the wrapper exposes (overridden
// where set, inherited otherwise). --accent-gradient additionally depends
// on the .cms-gradient class on .marketing-root — both flavors are emitted
// so only the matching one applies.
export function buildBlockOverrideCss(blockId: string | undefined, style: BlockStyle | undefined) {
    if (!style?.colorOverrides || !blockId) return null;
    // Only a value in one of the colour forms is written into the rule; any other value is no override.
    const co: Record<string, string> = cleanColorOverrides(style.colorOverrides);
    const decls = [];
    if (co.primary)       decls.push(`--brand-primary: ${co.primary};`);
    if (co.secondary)     decls.push(`--brand-secondary: ${co.secondary};`);
    if (co.accent)        decls.push(`--brand-accent: ${co.accent};`);
    if (co.background)    decls.push(`--brand-bg: ${co.background};`);
    if (co.surface)       decls.push(`--brand-surface: ${co.surface};`);
    if (co.text)          decls.push(`--brand-text: ${co.text};`);
    if (co.textSecondary) decls.push(`--brand-text-secondary: ${co.textSecondary};`);
    if (decls.length === 0) return null;

    // The id goes into a quoted attribute selector: '"' is left out (as it always was), letters,
    // digits, "_" and "-" are written as they are, and any other character as a CSS hex escape,
    // which names the same character, so the selector still matches the block's attribute.
    const safeId = selectorString(String(blockId));
    if (!safeId) return null;
    const sel = `[data-cms-block-id="${safeId}"]`;

    // Aliases that must be re-evaluated on the wrapper so descendants see
    // the overridden brand tokens. Mirrors the alias declarations in
    // marketing.css's .marketing-root rule (minus the hard-coded ones like
    // --text-muted / --border-subtle, which the override layer doesn't
    // attempt to recompute).
    const aliases = [
        '--accent: var(--brand-primary);',
        '--accent-light: var(--brand-accent);',
        '--bg-primary: var(--brand-bg);',
        '--bg-secondary: var(--brand-surface);',
        '--text-primary: var(--brand-text);',
        '--text-secondary: var(--brand-text-secondary);',
    ];

    // Inherited CSS properties (color, background) are computed *once* on
    // .marketing-root from var(--text-primary)/var(--bg-primary) and
    // descendants inherit the RESOLVED value — not the variable. So a
    // wrapper that only redeclares the variables doesn't change anything
    // for sections like Media+Text that have no own color/background
    // rules. We re-paint these on the wrapper itself when the user
    // explicitly overrides them, so descendants inherit from the wrapper
    // instead of the marketing-root. Only emitted on demand to avoid
    // forcing a background color on blocks that didn't ask for one.
    if (co.text)       aliases.push('color: var(--text-primary);');
    if (co.background) aliases.push('background-color: var(--bg-primary);');

    return [
        `${sel} { ${decls.join(' ')} ${aliases.join(' ')} }`,
        // Gradient flavor — matches when the site has gradient mode on.
        `.marketing-root.cms-gradient ${sel} { --accent-gradient: linear-gradient(135deg, var(--brand-primary) 0%, var(--brand-accent) 100%); }`,
        // Solid flavor — matches when gradient mode is off.
        `.marketing-root:not(.cms-gradient) ${sel} { --accent-gradient: var(--brand-primary); }`,
    ].join(' ');
}
