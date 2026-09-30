/**
 * The web's design tokens, generated — and kept that way.
 *
 * generated/webTokens.generated.ts is what scripts/sync-web-tokens.mjs makes
 * of agent-hub/src/index.css and applyTheme.js. This runs the generator's
 * pure `generate()` on the stylesheet as it is today (in a Node child: Jest
 * cannot load an .mjs module) and compares its output with the committed
 * file, so every token is pinned, not the 18 a hand-kept map used to list.
 *
 * When it fails, the web changed: run `npm run sync:tokens` and commit the
 * result. Don't edit the generated file.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { FONT_FAMILIES } from './fonts';
import {
    WEB_ACCENT_TINTS,
    WEB_FONT_STACKS,
    WEB_THEMES,
    WEB_TOKENS,
} from './generated/webTokens.generated';
import { PALETTES, THEME_NAMES } from './tokens';

// React Native's own parser for the `boxShadow` style (no type declarations ship for it).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const processBoxShadow = require('react-native/Libraries/StyleSheet/processBoxShadow').default as (
    value: string,
) => { color?: unknown }[];

const MOBILE = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(MOBILE, 'scripts/sync-web-tokens.mjs');
const GENERATED = path.join(__dirname, 'generated/webTokens.generated.ts');
const CSS = path.resolve(MOBILE, '../agent-hub/src/index.css');

// The mobile package is publishable on its own and someone may check it out
// without the sibling. Skipping loudly beats failing for the wrong reason.
const describeIfWeb = fs.existsSync(CSS) ? describe : describe.skip;

describeIfWeb('webTokens.generated.ts', () => {
    it('is what scripts/sync-web-tokens.mjs generates from the web today', () => {
        const fresh = execFileSync(process.execPath, [SCRIPT, '--print'], {
            cwd: MOBILE,
            encoding: 'utf8',
            stdio: 'pipe',
        });
        expect(fs.readFileSync(GENERATED, 'utf8')).toBe(fresh);
    });
});

/**
 * What the generator has to do right, run on a stylesheet small enough to
 * read: the cascade the browser applies to <html data-theme>, var() with
 * fallbacks, color-mix, and the selectors that style some other element.
 */
describe('scripts/sync-web-tokens.mjs', () => {
    const FIXTURE = `
        @import "tailwindcss";
        :root, [data-theme="ink"] { --type-x: #111111; }
        [data-theme="paper"] { --type-x: #222222; }
        :root {
            --bg-primary: #000;
            --text-primary: #EEEEEE;
            --hover: color-mix(in srgb, var(--text-primary) 7%, transparent);
            --missing: var(--nope, #123456);
        }
        [data-theme="paper"] { --bg-primary: #fff; --text-primary: #111; }
        [data-theme="ink"] { --bg-primary: #010101; }
        [data-theme="ink"] { --type-x: #333333; }
        [data-theme^="pa"] { --glassy: rgba(1,2,3,.5); }
        [data-theme="paper"] .card { --text-primary: red; }
        @media (prefers-reduced-motion: reduce) { :root { --text-primary: blue; } }
    `;

    function run(expression: string): unknown {
        const src = `import * as g from ${JSON.stringify(SCRIPT)};
            const rules = g.parseRules(${JSON.stringify(FIXTURE)});
            const read = (theme) => {
                const p = g.cascade(rules, theme);
                return (name) => g.substitute(p.get(name), p);
            };
            process.stdout.write(JSON.stringify(${expression}));`;
        const out = execFileSync(process.execPath, ['--input-type=module', '-e', src], {
            encoding: 'utf8',
            stdio: 'pipe',
        });
        return JSON.parse(out);
    }

    it('finds the themes that declare a palette, :root first as dark', () => {
        expect(run('g.themeNames(rules)')).toEqual(['dark', 'paper', 'ink']);
    });

    it('lets a later block for one theme override its group, and ignores other elements and at-rules', () => {
        expect(
            run(`[read('dark')('--type-x'), read('paper')('--type-x'), read('ink')('--type-x'),
                  read('paper')('--text-primary'), read('dark')('--text-primary')]`),
        ).toEqual(['#111111', '#222222', '#333333', '#111', '#EEEEEE']);
    });

    it("resolves var() on the root element, so a :root recipe uses each theme's own value", () => {
        expect(
            run(`[
                g.normaliseColor(read('dark')('--hover')),
                g.normaliseColor(read('paper')('--hover')),
                read('dark')('--missing'),
                read('paper')('--glassy'),
                g.cascade(rules, 'dark').has('--glassy'),
            ]`),
        ).toEqual(['rgba(238, 238, 238, 0.07)', 'rgba(17, 17, 17, 0.07)', '#123456', 'rgba(1,2,3,.5)', false]);
    });

    it('refuses a value React Native could not paint rather than guessing', () => {
        expect(() => run(`g.normaliseColor('hsl(10 20% 30%)')`)).toThrow(/Not a colour/);
        expect(() => run(`g.normaliseShadow('0 0 1em red')`)).toThrow(/Not a box-shadow/);
    });
});

describe('the generated tokens', () => {
    it('name the same themes, in the same order, as the palettes', () => {
        expect([...THEME_NAMES]).toEqual([...WEB_THEMES]);
        expect(Object.keys(PALETTES)).toEqual([...WEB_THEMES]);
        expect(WEB_THEMES[0]).toBe('dark');
    });

    it('keep the web-only concepts resolved: no var() or color-mix left', () => {
        const text = JSON.stringify(WEB_TOKENS);
        expect(text).not.toMatch(/var\(|color-mix|calc\(/);
    });

    it("give high-contrast the dark set's --type-ai and its own status inks, as index.css documents", () => {
        // The one theme that opts out of its two-set group for these, because
        // they are read as TEXT on its #000000 card. Pinned so the cascade in
        // the generator is checked against a fact the stylesheet states.
        const hc = WEB_TOKENS['high-contrast'];
        expect(hc.stepType.ai).toBe(WEB_TOKENS.dark.stepType.ai);
        expect(hc.stepType.trigger).toBe(WEB_TOKENS.light.stepType.trigger);
        expect([hc.colors.successInk, hc.colors.warningInk, hc.colors.errorInk]).toEqual([
            hc.colors.success,
            hc.colors.warning,
            hc.colors.error,
        ]);
    });

    it("end every flow in the theme's own ink", () => {
        for (const theme of WEB_THEMES) {
            expect(WEB_TOKENS[theme].stepType.end).toBe(WEB_TOKENS[theme].colors.textPrimary);
        }
    });

    it('mix the selected-row tint from the accent', () => {
        expect(WEB_ACCENT_TINTS.itemActiveBg).toBeGreaterThan(0);
        expect(WEB_TOKENS.dark.colors.itemActiveBg).toBe(`rgba(156, 163, 175, ${WEB_ACCENT_TINTS.itemActiveBg})`);
    });

    it('carry shadows React Native parses, every layer of them', () => {
        const bad: string[] = [];
        for (const theme of WEB_THEMES) {
            for (const [name, value] of Object.entries(WEB_TOKENS[theme].shadows)) {
                const layers = value.split(/,(?![^()]*\))/).length;
                const parsed = processBoxShadow(value);
                if (parsed.length !== layers || parsed.some((s) => s.color == null)) {
                    bad.push(`${theme}.${name}: ${value}`);
                }
            }
        }
        expect(bad).toEqual([]);
    });

    it("map every web font choice to faces the phone has, or to the platform's", () => {
        expect(Object.keys(WEB_FONT_STACKS).sort()).toEqual(['system', ...Object.keys(FONT_FAMILIES)].sort());
    });
});
