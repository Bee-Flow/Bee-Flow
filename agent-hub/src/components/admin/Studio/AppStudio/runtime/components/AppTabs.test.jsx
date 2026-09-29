import { fireEvent, render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import AppTabs, { tabBadgeContent } from './AppTabs';
import { RuntimeProvider, buildScope, DEFAULT_RUNTIME } from '../RuntimeContext';

/**
 * tabs.look (spec: server/appStudio/componentSpecs.js).
 *
 * 'underline' is the IDENTITY value — truthfully named: the component has
 * always rendered a bottom-ruled strip whose active tab carries a 2px
 * var(--app-primary) underline. The default tests pin that exact markup
 * (class strings AND style values), so a stored definition backfilled with
 * look:'underline' renders byte-identically.
 *
 * Behaviour (gating, panel mounting, error-tab surfacing) is covered by
 * containers.test.jsx through AppRenderer; this file is about the strip's
 * visual registers only.
 */

function withRuntime(ui, overrides = {}) {
    const value = { ...DEFAULT_RUNTIME, scope: buildScope({ now: '2026-01-01T00:00:00.000Z' }), ...overrides };
    return render(<RuntimeProvider value={value}>{ui}</RuntimeProvider>);
}

function tabsNode(props = {}) {
    return {
        id: 'cmp_tabs', type: 'tabs', visible: true, props,
        style: { span: 12, gap: 3, padding: 0 },
        children: [
            { id: 'cmp_ta', type: 'tab', visible: true, props: { label: 'First', icon: null }, children: [] },
            { id: 'cmp_tb', type: 'tab', visible: true, props: { label: 'Second', icon: null }, children: [] },
        ],
    };
}

function renderTabs(props = {}, overrides = {}) {
    return withRuntime(
        <AppTabs node={tabsNode(props)}>
            <div>Panel A</div>
            <div>Panel B</div>
        </AppTabs>,
        { mode: 'run', ...overrides },
    );
}

// The exact class strings the default look must keep. What these pin is that
// `look` is opt-in — an app that never set it renders the same markup as every
// other underline strip. The scrolling half (overflow-x-auto, shrink-0,
// whitespace-nowrap) was added later and applies to ALL looks: a strip of tabs
// squeezed into a narrow screen is unreadable in every one of them.
const IDENTITY_STRIP_CLS = 'flex items-center gap-1 border-b overflow-x-auto app-scroll-x';
const IDENTITY_TAB_CLS = 'inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 px-3 py-2 text-sm font-medium -mb-px';

describe('AppTabs — look: underline is the identity', () => {
    it('renders todays exact strip and button markup when look is absent', () => {
        const { container, getByRole } = renderTabs();
        expect(container.querySelector('[data-app-tabs]').getAttribute('data-app-tabs-look')).toBeNull();

        const strip = getByRole('tablist');
        expect(strip.className).toBe(IDENTITY_STRIP_CLS);
        expect(strip.style.borderColor).toBe('var(--border-default)');

        const active = getByRole('tab', { name: 'First' });
        expect(active.className).toBe(IDENTITY_TAB_CLS);
        expect(active.style.borderBottom).toBe('2px solid var(--app-primary)');
        expect(active.style.color).toBe('var(--app-primary)');

        const inactive = getByRole('tab', { name: 'Second' });
        expect(inactive.className).toBe(IDENTITY_TAB_CLS);
        expect(inactive.style.borderBottom).toBe('2px solid transparent');
        expect(inactive.style.color).toBe('var(--text-secondary)');
    });

    it('an explicit look:"underline" and an unknown look both take the identity path', () => {
        for (const look of ['underline', 'holographic']) {
            const utils = renderTabs({ look });
            expect(utils.container.querySelector('[data-app-tabs]').getAttribute('data-app-tabs-look')).toBeNull();
            expect(utils.container.querySelector('[role="tablist"]').className).toBe(IDENTITY_STRIP_CLS);
            expect(utils.container.querySelector('[role="tab"]').className).toBe(IDENTITY_TAB_CLS);
            utils.unmount(); // two renders in one test — do not let queries see both
        }
    });
});

describe('AppTabs — look: pills', () => {
    it('renders rounded pill tabs; active = primary-soft bg + primary text; no bottom rule', () => {
        const { container, getByRole } = renderTabs({ look: 'pills' });
        expect(container.querySelector('[data-app-tabs]').getAttribute('data-app-tabs-look')).toBe('pills');

        const strip = getByRole('tablist');
        expect(strip.className).not.toContain('border-b');

        const active = getByRole('tab', { name: 'First' });
        expect(active.className).toContain('rounded-full');
        expect(active.style.background).toBe('var(--app-primary-soft)');
        expect(active.style.color).toBe('var(--app-primary)');

        const inactive = getByRole('tab', { name: 'Second' });
        expect(inactive.style.background).toBe('transparent');
        expect(inactive.style.color).toBe('var(--text-secondary)');
    });

    it('motion is token-gated, so .app-motion--none can kill it', () => {
        const { getByRole } = renderTabs({ look: 'pills' });
        expect(getByRole('tab', { name: 'First' }).style.transition).toContain('var(--app-motion-fast, 0ms)');
    });

    it('still switches tabs on click', () => {
        const { getByRole } = renderTabs({ look: 'pills' });
        fireEvent.click(getByRole('tab', { name: 'Second' }));
        expect(getByRole('tab', { name: 'Second' }).getAttribute('aria-selected')).toBe('true');
        expect(getByRole('tab', { name: 'Second' }).style.background).toBe('var(--app-primary-soft)');
    });
});

describe('AppTabs — look: boxed', () => {
    it('renders a bordered bar whose active tab is joined to the panel', () => {
        const { container, getByRole } = renderTabs({ look: 'boxed' });
        expect(container.querySelector('[data-app-tabs]').getAttribute('data-app-tabs-look')).toBe('boxed');

        const strip = getByRole('tablist');
        expect(strip.style.borderBottom).toBe('1px solid var(--border-default)');

        const active = getByRole('tab', { name: 'First' });
        expect(active.className).toContain('border');
        expect(active.style.background).toBe('var(--bg-card)');
        // The open bottom edge is the join: the strip's rule runs behind it and
        // the card surface continues into the panel.
        expect(active.style.borderBottomColor).toBe('transparent');
        expect(active.style.borderTopLeftRadius).toBe('var(--app-radius)');

        const inactive = getByRole('tab', { name: 'Second' });
        expect(inactive.style.background).toBe('transparent');
        expect(inactive.style.color).toBe('var(--text-secondary)');
    });
});

/**
 * tab.badge / tab.badgeTone (spec: server/appStudio/componentSpecs.js).
 * The strip reads raw child defs, so the badge binding resolves inside AppTabs
 * against the runtime scope. 'neutral' (the identity tone) is a bare muted
 * count; any other COLOR_ROLES tone is a small 17px tinted pill. An empty or
 * zero value renders nothing at all.
 */
describe('AppTabs — tab badges', () => {
    function renderBadged(firstTabProps, overrides = {}) {
        const node = tabsNode();
        node.children[0].props = { label: 'First', icon: null, ...firstTabProps };
        return withRuntime(
            <AppTabs node={node}>
                <div>Panel A</div>
                <div>Panel B</div>
            </AppTabs>,
            { mode: 'run', ...overrides },
        );
    }

    it('no badge prop renders no badge node (identity)', () => {
        const { container } = renderBadged({});
        expect(container.querySelector('[data-app-tab-badge]')).toBeNull();
    });

    it('a neutral badge is a bare muted count, not a pill', () => {
        const { container, getByRole } = renderBadged({ badge: { kind: 'static', value: 3 }, badgeTone: 'neutral' });
        const badge = container.querySelector('[data-app-tab-badge]');
        expect(badge.getAttribute('data-app-tab-badge')).toBe('neutral');
        expect(badge.textContent).toBe('3');
        expect(badge.style.color).toBe('var(--text-muted)');
        expect(badge.className).not.toContain('rounded-full');
        expect(getByRole('tab', { name: /First/ }).contains(badge)).toBe(true);
    });

    it('a toned badge is a 17px pill with the tone wash and tone text', () => {
        const { container } = renderBadged({ badge: { kind: 'static', value: 6 }, badgeTone: 'danger' });
        const badge = container.querySelector('[data-app-tab-badge]');
        expect(badge.getAttribute('data-app-tab-badge')).toBe('danger');
        expect(badge.textContent).toBe('6');
        expect(badge.className).toContain('rounded-full');
        expect(badge.style.height).toBe('17px');
        expect(badge.getAttribute('style')).toContain('color-mix');
    });

    it('the badge binding resolves against the runtime scope', () => {
        const { container } = renderBadged(
            { badge: { kind: 'formula', expr: 'vars.openCount' }, badgeTone: 'warning' },
            { scope: buildScope({ vars: { openCount: 9 }, now: '2026-01-01T00:00:00.000Z' }) },
        );
        expect(container.querySelector('[data-app-tab-badge]').textContent).toBe('9');
    });

    it('empty and zero values show nothing', () => {
        for (const value of [null, '', 0, '0', false]) {
            const utils = renderBadged({ badge: { kind: 'static', value }, badgeTone: 'danger' });
            expect(utils.container.querySelector('[data-app-tab-badge]'), String(value)).toBeNull();
            utils.unmount();
        }
    });

    it('tabBadgeContent never renders objects or arrays', () => {
        expect(tabBadgeContent({ a: 1 })).toBeNull();
        expect(tabBadgeContent([1, 2])).toBeNull();
        expect(tabBadgeContent('NEW')).toBe('NEW');
        expect(tabBadgeContent(12)).toBe('12');
    });

    it('an unknown badgeTone falls back to the neutral counter', () => {
        const { container } = renderBadged({ badge: { kind: 'static', value: 2 }, badgeTone: 'holographic' });
        expect(container.querySelector('[data-app-tab-badge]').getAttribute('data-app-tab-badge')).toBe('neutral');
    });
});

describe('AppTabs — looks introduce no purple', () => {
    it.each(['underline', 'pills', 'boxed'])('%s look has no purple/violet/indigo', (look) => {
        const { container } = renderTabs({ look });
        expect(container.innerHTML).not.toMatch(/indigo|violet|purple|#6366f1|#4f46e5|#818cf8|#7c3aed|#a855f7/i);
    });
});
