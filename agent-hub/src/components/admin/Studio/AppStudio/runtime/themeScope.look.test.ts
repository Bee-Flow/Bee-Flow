// Theme scope (package LK16) in the DOM snapshot harness, under the light, dark and high-contrast
// host themes: the corpus app renders the same elements in every host theme (the look is CSS
// variables), and the stylesheet swaps the dark palette in only where it should.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { describeApp, fixedClock, noSession, SNAPSHOT_DIR } from '@/test/appLookRegression';

const HOSTS = ['', 'light', 'dark', 'high-contrast'] as const;
// The stylesheet as the browser gets it (vitest leaves CSS imports empty), parsed by the CSSOM.
const themeScopeCss = fs.readFileSync(path.resolve(SNAPSHOT_DIR, '../css/themeScope.css'), 'utf8');

function setHost(theme: string) {
    if (theme) document.documentElement.setAttribute('data-theme', theme);
    else document.documentElement.removeAttribute('data-theme');
}

/**
 * The --app-primary the stylesheet gives a root with these classes ('' when no rule applies).
 * jsdom keeps custom properties out of getComputedStyle, so the rules are matched here: the
 * last rule whose selector matches the root and that declares the variable decides.
 */
function primaryUnder(classes: string): string {
    const style = document.createElement('style');
    style.textContent = themeScopeCss;
    document.head.appendChild(style);
    const root = document.createElement('div');
    root.className = classes;
    document.body.appendChild(root);
    try {
        let value = '';
        for (const rule of Array.from(style.sheet?.cssRules || [])) {
            if (!(rule instanceof CSSStyleRule) || !root.matches(rule.selectorText)) continue;
            const declared = rule.style.getPropertyValue('--app-primary').trim();
            if (declared) value = declared;
        }
        return value;
    } finally {
        root.remove();
        style.remove();
    }
}

describe('theme scope across host themes', () => {
    let restoreClock: () => void = () => {};
    let restoreFetch: () => void = () => {};
    beforeAll(() => { restoreClock = fixedClock(); restoreFetch = noSession(); });
    afterAll(() => { restoreFetch(); restoreClock(); });
    afterEach(() => setHost(''));

    it('renders the same elements in light, dark and high contrast, with the scope hooks in place', async () => {
        const texts: string[] = [];
        for (const host of HOSTS) {
            setHost(host);
            const { text, crashed } = await describeApp('vocab-theme-scope');
            expect(crashed).toEqual([]);
            texts.push(text);
        }
        expect(new Set(texts).size).toBe(1);
        const [text] = texts;
        expect(text).toContain('app-dark-palette--auto');
        expect(text).toContain('app-dark-palette--on');
        expect(text).toContain('app-section--themed-ground');
        expect(text).toContain('var(--app-token-brand-soft)');
        expect(text).toContain('--app-radius: 6px');
    });

    it('swaps the dark palette in on a dark host or a dark app, never under high contrast', () => {
        const cases: Array<[string, string, boolean]> = [
            ['', 'app-dark-palette--auto', true],
            ['dark', 'app-dark-palette--auto', true],
            ['light', 'app-dark-palette--auto', false],
            ['high-contrast', 'app-dark-palette--auto', false],
            ['light', 'app-dark-palette--on', true],
            ['high-contrast', 'app-dark-palette--on', false],
        ];
        for (const [host, classes, dark] of cases) {
            setHost(host);
            const value = primaryUnder(classes);
            if (dark) expect(value, `${host || '(default)'} ${classes}`).toBe('var(--app-dark-primary)');
            else expect(value, `${host || '(default)'} ${classes}`).toBe('');
        }
    });
});
