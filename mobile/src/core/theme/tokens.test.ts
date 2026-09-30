/**
 * What the phone's tokens promise on top of the web's.
 *
 * The colours themselves are the web's, generated from index.css and pinned
 * by webTokens.lockstep.test.ts. What is checked here is what that cannot
 * check: that the palettes are readable where a phone reads them, that the
 * picker and the palette table agree, and the phone-only scales.
 */

import { DARK_THEMES, PALETTES, PICKABLE_THEMES, RADII, SPACING, THEME_NAMES, TYPE } from './tokens';

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
 * The derived colours.
 *
 * They exist because the palettes cannot be changed — they are the web app's
 * stylesheet, and the accent is org-brandable — while two of their
 * consequences are unreadable on a phone. So the contrast is
 * computed at runtime instead, and these tests are what stop that derivation
 * silently regressing to "whatever the accent happens to be".
 *
 * Deliberately re-implemented here rather than imported from color.ts:
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
 * The picker offers Day and Night (after "Match my phone"). The web's other
 * six left the picker, NOT the palette table, and these tests are what keeps
 * those two facts from drifting apart — the day someone "tidies up" by
 * deleting the entries, the generator and the lockstep test disagree, and an
 * org pinned to `paper` has nothing to resolve against.
 */
describe('PICKABLE_THEMES', () => {
    it('offers Day and Night, and each has a palette', () => {
        expect([...PICKABLE_THEMES]).toEqual(['light', 'dark']);
        for (const name of PICKABLE_THEMES) expect(PALETTES[name]).toBeDefined();
    });

    it('keeps the unpickable themes in the table anyway', () => {
        // A stored preference and an org-pinned branding preset both read
        // this table by name. Shrinking it is the crash.
        for (const name of ['glass', 'glass-dark', 'paper', 'sepia', 'obsidian', 'high-contrast'] as const) {
            expect(PALETTES[name]).toBeDefined();
        }
        expect(THEME_NAMES.length).toBe(8);
    });
});

describe('phone-only scales', () => {
    it("keeps the web's radii, plus the pill", () => {
        expect(RADII).toEqual({ sm: 8, md: 12, lg: 16, xl: 20, pill: 999 });
    });

    it("has every Tailwind step the web uses, half steps included, under the step's own name", () => {
        const steps = { 0.5: 2, 1: 4, 1.5: 6, 2: 8, 2.5: 10, 3: 12, 3.5: 14, 4: 16, 5: 20, 6: 24, 8: 32, 12: 48 };
        for (const [step, px] of Object.entries(steps)) {
            expect(SPACING[Number(step) as keyof typeof SPACING]).toBe(px);
        }
    });

    it('sizes the type scale for a phone: 22 titles down to an 11 floor', () => {
        const sizes = Object.fromEntries(Object.entries(TYPE).map(([k, v]) => [k, [v.fontSize, v.lineHeight]]));
        expect(sizes).toEqual({
            title: [22, 28],
            heading: [18, 24],
            subheading: [15, 20],
            body: [15, 22],
            caption: [13, 18],
            label: [11, 15],
            code: [13, 20],
        });
        expect([TYPE.title.fontWeight, TYPE.heading.fontWeight, TYPE.subheading.fontWeight]).toEqual([
            '600',
            '600',
            '600',
        ]);
        expect(TYPE.label.fontWeight).toBe('500');
    });
});
