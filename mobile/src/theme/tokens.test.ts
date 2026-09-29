/**
 * Drift guard between this app's tokens and the web app's stylesheet.
 *
 * tokens.ts is a hand port of agent-hub/src/index.css. A port cannot be
 * derived at build time — nothing shares a CSS custom property with a React
 * Native StyleSheet — so the only thing standing between the two clients and a
 * slow colour drift is a test that reads the real stylesheet and compares.
 *
 * This parses index.css rather than checking against a copied fixture: a
 * fixture would only prove tokens.ts matches a snapshot of itself, and would go
 * stale in exactly the situation this exists to catch.
 *
 * When this fails, the fix is almost always to update tokens.ts. It failing
 * means someone changed a colour on the web and the phone did not follow.
 */

import fs from 'node:fs';
import path from 'node:path';

import { DARK_THEMES, PALETTES, PICKABLE_THEMES, THEME_NAMES, type ThemeName } from './tokens';

const CSS_PATH = path.resolve(__dirname, '../../../agent-hub/src/index.css');

/**
 * The CSS custom properties that are load-bearing for the mobile port, mapped
 * to their Palette keys.
 *
 * Not every variable is here on purpose: shadows, glass tints and the wallpaper
 * layer are re-expressed rather than copied (React Native has no backdrop
 * filter and its shadow model is different), so pinning them would assert a
 * correspondence that does not exist.
 */
const TRACKED: Record<string, keyof (typeof PALETTES)['dark']> = {
    '--bg-primary': 'bgPrimary',
    '--bg-secondary': 'bgSecondary',
    '--bg-tertiary': 'bgTertiary',
    '--bg-card': 'bgCard',
    '--bg-card-hover': 'bgCardHover',
    '--accent-primary': 'accentPrimary',
    '--accent-secondary': 'accentSecondary',
    '--accent-primary-hover': 'accentPrimaryHover',
    '--accent-primary-fg': 'accentPrimaryFg',
    '--success': 'success',
    '--warning': 'warning',
    '--error': 'error',
    '--text-primary': 'textPrimary',
    '--text-secondary': 'textSecondary',
    '--text-muted': 'textMuted',
    '--text-tertiary': 'textTertiary',
    '--border-subtle': 'borderSubtle',
    '--border-default': 'borderDefault',
};

/**
 * Pull one theme's block out of index.css.
 *
 * `dark` is not a `[data-theme="dark"]` selector — it is the `:root` block, and
 * the high-contrast/paper/obsidian/sepia blocks come later in the file, so a
 * naive first-match search returns `:root` for every one of them. Anchor on the
 * exact selector and take the balanced brace run after it.
 */
function extractBlock(css: string, theme: ThemeName): string {
    const selector = theme === 'dark' ? ':root' : `[data-theme="${theme}"]`;
    // A selector can appear more than once (the one-line user-bubble rules at
    // the top of the file). The palette block is the one that declares
    // --bg-primary, so keep looking until we find it.
    let from = 0;
    for (;;) {
        const at = css.indexOf(selector, from);
        if (at === -1) throw new Error(`No palette block for "${theme}" in index.css`);
        const open = css.indexOf('{', at);
        const close = css.indexOf('}', open);
        const block = css.slice(open + 1, close);
        if (block.includes('--bg-primary')) return block;
        from = close + 1;
    }
}

/** Read a custom property out of a block, ignoring comments. */
function readVar(block: string, name: string): string | null {
    // Strip block comments first: index.css annotates several values with a
    // trailing /* ... */ that would otherwise land in the captured value.
    const clean = block.replace(/\/\*[\s\S]*?\*\//g, '');
    const match = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(clean);
    return match?.[1]?.trim() ?? null;
}

/** rgba(255, 255, 255, 0.06) and rgba(255,255,255,.06) are the same colour. */
function normalise(value: string): string {
    return value.replace(/\s+/g, '').replace(/0\./g, '.').toLowerCase();
}

const css = fs.existsSync(CSS_PATH) ? fs.readFileSync(CSS_PATH, 'utf8') : null;

// The mobile package is publishable on its own and someone may check it out
// without the sibling. Skipping loudly beats failing for the wrong reason.
const describeIfCss = css ? describe : describe.skip;

describeIfCss('tokens match agent-hub/src/index.css', () => {
    for (const theme of THEME_NAMES) {
        describe(theme, () => {
            for (const [cssVar, tokenKey] of Object.entries(TRACKED)) {
                it(`${cssVar} matches ${String(tokenKey)}`, () => {
                    const block = extractBlock(css as string, theme);
                    const declared = readVar(block, cssVar);
                    if (declared === null) {
                        // A theme that does not declare a variable inherits it,
                        // which index.css documents as deliberate for some
                        // values. Nothing to compare.
                        return;
                    }
                    // `transparent` on the glass themes is re-expressed in the
                    // port (RN has no root stacking context to be transparent
                    // against) — tokens.ts keeps the literal and paints a
                    // backdrop instead, so both spellings are correct.
                    expect(normalise(PALETTES[theme][tokenKey] as string)).toBe(
                        normalise(declared),
                    );
                });
            }
        });
    }
});

/**
 * `--type-ai` — the one tracked colour that is NOT in a per-theme block.
 *
 * index.css declares the `--type-*` step families twice: once for the three
 * dark themes and once for the five light ones. `extractBlock` above looks for
 * the block that declares `--bg-primary`, so it would never find these and the
 * comparison would pass by finding nothing — exactly the vacuous pass this
 * whole file exists to avoid. It is worth pinning: since CW-04 it is what a
 * RUNNING run wears on both clients, which is the only reason the phone has a
 * `typeAi` at all.
 */
describeIfCss('--type-ai matches index.css', () => {
    /** Selector list → value, for a property declared per GROUP of themes. */
    function twoSetDeclarations(name: string): { selectors: string; value: string }[] {
        const out: { selectors: string; value: string }[] = [];
        const clean = (css as string).replace(/\/\*[\s\S]*?\*\//g, '');
        const re = new RegExp(`([^{}]+)\\{([^}]*${name}\\s*:\\s*([^;]+);[^}]*)\\}`, 'g');
        for (const m of clean.matchAll(re)) {
            out.push({ selectors: (m[1] ?? '').trim(), value: (m[3] ?? '').trim() });
        }
        return out;
    }

    // A comma list is one of the two SETS; a lone `[data-theme="x"]` block is
    // that theme opting out of them, and wins in the cascade by coming later
    // at equal specificity.
    const declarations = twoSetDeclarations('--type-ai');
    const sets = declarations.filter((d) => d.selectors.includes(','));
    const overrides = declarations.filter((d) => !d.selectors.includes(','));

    it('finds exactly the two sets index.css documents', () => {
        expect(sets.length).toBe(2);
    });

    it('names every theme that opts out, so an unexplained one gets read', () => {
        // There is exactly one, and index.css says why in the block itself:
        // high-contrast's card is #000000 while its group is the LIGHT set, and
        // this token stopped being only a bar colour when it became the word
        // "Running" (CW-04). 4.28:1 there against 8.96:1 with the dark value.
        expect(overrides.map((d) => d.selectors)).toEqual(['[data-theme="high-contrast"]']);
    });

    for (const theme of THEME_NAMES) {
        it(`${theme} takes the value its own block, or its selector group, declares`, () => {
            // `dark` is the `:root` set; every other theme names itself.
            const needle = theme === 'dark' ? ':root' : `[data-theme="${theme}"]`;
            // Exactly one group must claim the theme: none means index.css
            // dropped it, two means the sets overlap and the "value" is
            // whichever rule happens to come last.
            const mine = sets.filter((s) => s.selectors.includes(needle));
            expect(mine.map((s) => s.selectors)).toHaveLength(1);
            const opted = overrides.find((d) => d.selectors === needle);
            expect(normalise(PALETTES[theme].typeAi)).toBe(
                normalise(opted?.value ?? mine[0]?.value ?? ''),
            );
        });
    }
});

describe('palette invariants', () => {
    it('declares every theme the picker offers', () => {
        expect(Object.keys(PALETTES).sort()).toEqual([...THEME_NAMES].sort());
    });

    it('never leaves textTertiary aliased to textMuted where index.css splits them', () => {
        // index.css calls this out at length: --text-tertiary is declared
        // literally in every theme because --text-muted failed WCAG AA at the
        // 9-11px sizes the builder uses it at.
        for (const theme of ['dark', 'light', 'sepia'] as const) {
            expect(PALETTES[theme].textTertiary).not.toBe(PALETTES[theme].textMuted);
        }
    });

    it('marks exactly the light-ink themes as dark', () => {
        expect([...DARK_THEMES].sort()).toEqual(
            ['dark', 'glass-dark', 'high-contrast', 'obsidian'].sort(),
        );
    });

    it('gives every theme a usable row-state pair', () => {
        for (const theme of THEME_NAMES) {
            expect(PALETTES[theme].itemHoverBg).toMatch(/^rgba\(/);
            expect(PALETTES[theme].itemActiveBg).toMatch(/^rgba\(/);
        }
    });
});

/**
 * The two derived colours.
 *
 * They exist because the palettes above cannot be changed — this file pins
 * them to the web app's stylesheet, and the accent is org-brandable — while
 * two of their consequences are unreadable on a phone. So the contrast is
 * computed at runtime instead, and these tests are what stop that derivation
 * silently regressing to "whatever the accent happens to be".
 *
 * Deliberately re-implemented here rather than imported from ThemeProvider:
 * a test that calls the same function it is checking proves only that the
 * function is consistent with itself.
 */
describe('derived contrast', () => {
    function relativeLuminance(hex: string): number {
        const h = hex.replace('#', '');
        const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
        const channel = (i: number) => {
            const v = parseInt(full.slice(i * 2, i * 2 + 2), 16) / 255;
            return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
    }

    function ratio(a: string, b: string): number {
        const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [
            number,
            number,
        ];
        return (hi + 0.05) / (lo + 0.05);
    }

    /** The palettes whose values are plain hex — the glass ones are not. */
    const HEX_THEMES = THEME_NAMES.filter((name) => /^#[0-9a-f]{6}$/i.test(PALETTES[name].bgCard));

    it('has an accent shade that clears AA on the card, in every theme', () => {
        // The failure this pins: `accentPrimary` is #9ca3af on both default
        // themes, which is 2.8:1 on the dark card. Every inline link, every
        // "Try again", every accent caption was below the line.
        const unreadable = HEX_THEMES.filter((name) => {
            const p = PALETTES[name];
            return ![p.accentPrimary, p.accentPrimaryHover, p.accentSecondary].some(
                (shade) => ratio(shade, p.bgCard) >= 4.5,
            );
        });
        expect(unreadable).toEqual([]);
    });

    it('names the themes where a card needs a stronger border to be visible', () => {
        // Not a bug to fix in the table — obsidian's bgCard and bgSecondary
        // are the same value in index.css too. Pinned so that if the web app
        // ever separates them, the derivation stops firing here and somebody
        // notices rather than the border quietly getting heavier.
        const needStrongerBorder = HEX_THEMES.filter(
            (name) => ratio(PALETTES[name].bgCard, PALETTES[name].bgSecondary) < 1.15,
        );
        expect(needStrongerBorder).toContain('obsidian');
    });

    it('keeps typeAi readable on cards — it is a word now, not just a bar', () => {
        // The hole this plugs. `--type-ai` arrived as a step-family colour for
        // 4px bars and icon tiles, where 3:1 is the bar to clear; CW-04 then
        // made it the ink a RUNNING run is written in, on both clients. On the
        // high-contrast palette — a #000000 card that index.css groups with the
        // LIGHT themes — the light #3f6fc4 measured 4.28:1 and nothing here
        // noticed, because the three tests around this one cover accentPrimary,
        // the card border and textTertiary and stop there.
        const failing = HEX_THEMES.filter(
            (name) => ratio(PALETTES[name].typeAi, PALETTES[name].bgCard) < 4.5,
        );
        expect(failing).toEqual([]);
    });

    it('keeps textTertiary readable on cards, since TextTone has no muted', () => {
        // `muted` was removed from TextTone precisely because textMuted fails
        // here. If textTertiary ever drifts the same way, 242 call sites go
        // under the line at once and nothing else would catch it.
        const failing = HEX_THEMES.filter(
            (name) => ratio(PALETTES[name].textTertiary, PALETTES[name].bgCard) < 4.5,
        );
        expect(failing).toEqual([]);
    });
});

/**
 * The picker's set, and the crash that removing a theme would otherwise cause.
 *
 * `glass` and `glass-dark` left the picker because expo-blur renders them as a
 * flat wash on Android. They did NOT leave the palette table, and these tests
 * are what keeps those two facts from drifting apart — the day someone
 * "tidies up" by deleting the entries, a device that stored `glass` as its
 * preference resolves to an undefined palette and cannot start.
 */
describe('PICKABLE_THEMES', () => {
    it('offers only themes that render, and every one has a palette', () => {
        expect(PICKABLE_THEMES).not.toContain('glass');
        expect(PICKABLE_THEMES).not.toContain('glass-dark');
        for (const name of PICKABLE_THEMES) expect(PALETTES[name]).toBeDefined();
    });

    it('keeps the unpickable themes in the table anyway', () => {
        // A stored preference, an org-pinned branding preset and the drift
        // guard above all read this table by name. Shrinking it is the crash.
        expect(PALETTES.glass).toBeDefined();
        expect(PALETTES['glass-dark']).toBeDefined();
        expect(THEME_NAMES.length).toBe(PICKABLE_THEMES.length + 2);
    });
});
