/**
 * The rich renderers' fixed colours, each found in the web file it comes
 * from — the report renderers, the page renderer and the Mermaid theme are
 * painted in literals on the web too, so a change there fails here.
 */

import fs from 'node:fs';

import { AGENT_HUB_SRC } from '@/shared/testing/webModule';

import { BRAND_GRADIENT, CALLOUT, CARD_ACCENT, firstColor, HERO_GRADIENT, TEST_CATEGORY, TEST_SEVERITY, TEST_STATUS } from './richPalette';
import { MERMAID_THEME } from '../mermaid/mermaidTheme';
import { BADGE_COLORS, BUTTON_GRADIENTS, CHANGE_DOWN, CHANGE_UP, STAT_COLORS } from '../page/pagePalette';

const web = (file: string) => fs.readFileSync(`${AGENT_HUB_SRC}/components/renderers/${file}`, 'utf8');
const RESEARCH = web('ResearchRenderer.jsx');
const TEST_REPORT = web('TestReportRenderer.jsx');
const PAGE = web('PageRenderer.jsx');
const MERMAID = web('MermaidRenderer.jsx');

describe('research and test reports', () => {
    it('use the web’s gradients', () => {
        expect(RESEARCH).toContain(`linear-gradient(90deg, ${BRAND_GRADIENT.join(', ')}, transparent)`);
        expect(RESEARCH).toContain(`linear-gradient(135deg, ${HERO_GRADIENT[0]} 0%, ${HERO_GRADIENT[1]} 50%, ${HERO_GRADIENT[2]} 100%)`);
        expect(PAGE).toContain(`linear-gradient(90deg, ${CARD_ACCENT.join(', ')})`);
    });

    it.each(Object.entries(CALLOUT))('tints a %s callout as the web does', (variant, c) => {
        expect(RESEARCH).toContain(`${variant}: { bg: '${c.bg}', border: '${c.border}', color: '${c.color}'`);
    });

    it.each(Object.entries(TEST_STATUS))('colours a %s test as the web does', (status, s) => {
        expect(TEST_REPORT).toContain(`${status}: { color: '${s.color}', bg: '${s.bg}'`);
    });

    it('colours categories and severities as the web does', () => {
        for (const [key, color] of Object.entries(TEST_CATEGORY)) expect(TEST_REPORT).toMatch(new RegExp(`${key}: \\{ icon: .*color: '${color}'`));
        for (const [key, color] of Object.entries(TEST_SEVERITY)) expect(TEST_REPORT).toContain(`${key}: '${color}'`);
    });

    it('reads the first colour of a model’s gradient', () => {
        expect(firstColor('linear-gradient(135deg, #10b981, #059669)')).toBe('#10b981');
        expect(firstColor('rgba(1, 2, 3, 0.5)')).toBe('rgba(1, 2, 3, 0.5)');
        expect(firstColor('red')).toBeNull();
    });
});

describe('pages', () => {
    it.each(Object.entries(BUTTON_GRADIENTS))('paints a %s button as the web does', (variant, gradient) => {
        if (gradient) expect(PAGE).toContain(`${variant}: { bg: 'linear-gradient(135deg, ${gradient[0]}, ${gradient[1]})'`);
        else expect(PAGE).toContain(`${variant}: { bg: 'var(--bg-tertiary)'`);
    });

    it.each(Object.entries({ ...STAT_COLORS, ...BADGE_COLORS }))('tints %s as the web does', (key, tone) => {
        if (tone) expect(PAGE).toContain(`${key}: { bg: '${tone.bg}', color: '${tone.color}' }`);
        else expect(PAGE).toMatch(new RegExp(`${key}: \\{ bg: 'var\\(--bg-`));
    });

    it('colours a change up and down as the web does', () => {
        expect(PAGE).toContain(`element.change > 0 ? '${CHANGE_UP}' : '${CHANGE_DOWN}'`);
    });
});

describe('Mermaid', () => {
    it.each(Object.entries(MERMAID_THEME))('%s is the web theme’s', (key, value) => {
        expect(MERMAID).toContain(`${key}: '${value}',`);
    });
});
