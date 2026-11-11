/**
 * App Studio validator: theme scope and tokens (package LK16).
 *
 *   errors    a screen.theme or section.theme in a form canonicalize would change (canonical
 *             bytes handed in directly: an unknown key, an illegal value, canvas on a section)
 *   warnings  a theme override whose canvas leaves the screen's text hard to read, the same for
 *             design.dark.canvas against the dark theme text (the boxContrast.mts approach: the
 *             light and dark theme text the runtime re-declares, the high-contrast host not
 *             modelled), and a `token:<name>` colour that names no colour token of design.tokens
 *             (it paints nothing)
 *
 * A definition without these keys gets no finding from here.
 */

import { createRequire } from 'node:module';
import { contrastRatio, isHexColor, MIN_CONTRAST, modesOf, THEME_TEXT } from './boxContrast.mts';
import { colourTokenNames, definitionStyles } from '../designTokens.mts';
import { cleanScreenTheme, cleanSectionTheme } from '../canonicalize/scopeTheme.mts';
import { sameJsonValue } from '../../shared/format/sameJsonValue.mjs';
import type { Finding } from '../definitionKeyRegistry.mts';

type Obj = Record<string, unknown>;
type PushFinding = (f: Finding) => void;
type Cleaner = (raw: unknown, path: string, push: (code: string, path: string, message: string) => void) => unknown;

const nodeRequire = createRequire(import.meta.url);
const { tokenNameOf } = nodeRequire('../componentSpecs/colorValue.js') as { tokenNameOf: (v: unknown) => string | null };

const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** An override that canonicalize would change is an error per repair (or one when only its form differs). */
function checkOverrideForm(value: unknown, clean: Cleaner, path: string, pushE: PushFinding): void {
    const problems: { path: string; message: string }[] = [];
    const cleaned = clean(value, path, (_code, at, message) => problems.push({ path: at, message }));
    if (!problems.length && !sameJsonValue(cleaned, value)) problems.push({ path, message: `${path} is not in its canonical form.` });
    for (const p of problems) {
        pushE({ code: 'theme_override.invalid', severity: 'error', path: p.path, message: p.message, hint: 'Name only theme keys with a legal value (#rrggbb for the colours); a section takes every key but canvas.' });
    }
}

/** A warning when `canvas` leaves the theme text under `theme` below AA in one of its modes. */
function checkCanvas(canvas: unknown, theme: unknown, path: string, pushW: PushFinding, modes = modesOf(theme)): void {
    if (!isHexColor(canvas)) return;
    const failing = modes.filter((mode) => contrastRatio(canvas, THEME_TEXT[mode].primary) < MIN_CONTRAST);
    if (!failing.length) return;
    const ratio = Math.min(...failing.map((mode) => contrastRatio(canvas, THEME_TEXT[mode].primary)));
    const where = failing.length === 2 ? 'in the light theme and in the dark one' : `in the ${failing[0]} theme`;
    pushW({
        code: 'theme_override.low_contrast', severity: 'warning', path,
        message: `canvas ${canvas} leaves the text on it at ${ratio.toFixed(1)}:1 ${where}; body text needs ${MIN_CONTRAST}:1.`,
        hint: 'A canvas stays the same in every theme while the text follows the theme. Pick a canvas that reads with that text, or fix appearance to light or dark in the same override.',
    });
}

function checkScreens(def: Obj, screens: unknown[], pushE: PushFinding, pushW: PushFinding): void {
    screens.forEach((screen, si) => {
        if (!isObj(screen)) return;
        const sp = `screens[${si}]`;
        if (screen.theme !== undefined) {
            checkOverrideForm(screen.theme, cleanScreenTheme, `${sp}.theme`, pushE);
            if (isObj(screen.theme)) checkCanvas(screen.theme.canvas, { ...(isObj(def.theme) ? def.theme : {}), ...screen.theme }, `${sp}.theme.canvas`, pushW);
        }
        const sections = Array.isArray(screen.sections) ? screen.sections : [];
        sections.forEach((section, ci) => {
            if (isObj(section) && section.theme !== undefined) checkOverrideForm(section.theme, cleanSectionTheme, `${sp}.sections[${ci}].theme`, pushE);
        });
    });
}

function checkTokenRefs(def: Obj, pushW: PushFinding): void {
    const known = colourTokenNames(def.design);
    for (const [style, path] of definitionStyles(def)) {
        for (const [knob, value] of Object.entries(style)) {
            const name = tokenNameOf(value);
            if (name === null || known.has(name)) continue;
            pushW({
                code: 'style.token_unknown', severity: 'warning', path: `${path}.${knob}`,
                message: `${knob} uses token "${name}", which is not a colour token of design.tokens — it paints nothing.`,
                hint: known.size ? `Colour tokens of this app: ${[...known].join(', ')}.` : 'Define it in design.tokens with app_set_theme { tokens: { "<name>": "#rrggbb" } }.',
            });
        }
    }
}

/** Every LK16 finding of a definition. */
export function checkThemeScope(def: Obj, screens: unknown, pushE: PushFinding, pushW: PushFinding): void {
    if (Array.isArray(screens)) checkScreens(def, screens, pushE, pushW);
    checkTokenRefs(def, pushW);
    const dark = isObj(def.design) && isObj(def.design.dark) ? def.design.dark : null;
    if (dark) checkCanvas(dark.canvas, def.theme, 'design.dark.canvas', pushW, ['dark']);
}
