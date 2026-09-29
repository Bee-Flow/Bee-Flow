import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import AppBadgeList from './AppBadgeList';
import { RuntimeProvider, buildScope, DEFAULT_RUNTIME } from '../RuntimeContext';

/**
 * badge_list.look (spec: server/appStudio/componentSpecs.js).
 *
 * 'soft' is the IDENTITY value: it must render the exact swatches the
 * component produced before the look prop existed — the 12% currentColor wash
 * for mapped roles, the --bg-tertiary pill for unmapped ones, and no marker
 * attribute. The default tests here pin that byte-for-byte, so a stored
 * definition that canonicalize backfills with look:'soft' cannot drift.
 */

function withRuntime(ui, overrides = {}) {
    const value = { ...DEFAULT_RUNTIME, scope: buildScope({ now: '2026-01-01T00:00:00.000Z' }), ...overrides };
    return render(<RuntimeProvider value={value}>{ui}</RuntimeProvider>);
}

const ROWS = [
    { label: 'Open', tone: 'open' },
    { label: 'Urgent', tone: 'urgent' },
    { label: 'Unmapped', tone: 'other' },
];

const MAP = [
    { value: 'open', color: 'success' },
    { value: 'urgent', color: 'primary' },
];

function node(props = {}) {
    return {
        id: 'cmp_bl', type: 'badge_list', visible: true,
        props: {
            source: { kind: 'static', value: ROWS },
            labelKey: 'label', colorKey: 'tone', colorMap: MAP,
            emptyText: 'x',
            ...props,
        },
        style: { span: 12 },
    };
}

const badgeOf = (utils, text) => utils.getByText(text);

describe('AppBadgeList — look: soft is the identity', () => {
    it('renders todays exact swatches and no look marker when look is absent', () => {
        const utils = withRuntime(<AppBadgeList node={node()} />);
        const root = utils.container.querySelector('[data-app-badgelist]');
        expect(root.getAttribute('data-app-badgelist-look')).toBeNull();

        // jsdom lowercases keywords inside color-mix — compare case-insensitively.
        const open = badgeOf(utils, 'Open');
        expect(open.style.background.toLowerCase()).toBe('color-mix(in srgb, currentcolor 12%, transparent)');
        expect(open.style.borderColor.toLowerCase()).toBe('color-mix(in srgb, currentcolor 35%, transparent)');

        const unmapped = badgeOf(utils, 'Unmapped');
        expect(unmapped.style.background).toBe('var(--bg-tertiary)');
        expect(unmapped.style.color).toBe('var(--text-secondary)');
        expect(unmapped.style.borderColor).toBe('var(--border-default)');
    });

    it('an explicit look:"soft" and an unknown look both take the identity path', () => {
        for (const look of ['soft', 'chrome-from-the-future']) {
            const utils = withRuntime(<AppBadgeList node={node({ look })} />);
            const root = utils.container.querySelector('[data-app-badgelist]');
            expect(root.getAttribute('data-app-badgelist-look')).toBeNull();
            expect(badgeOf(utils, 'Open').style.background.toLowerCase()).toBe('color-mix(in srgb, currentcolor 12%, transparent)');
            utils.unmount(); // two renders in one test — do not let queries see both
        }
    });
});

describe('AppBadgeList — look: outline', () => {
    it('renders transparent pills with the role speaking through border and text', () => {
        const utils = withRuntime(<AppBadgeList node={node({ look: 'outline' })} />);
        const root = utils.container.querySelector('[data-app-badgelist]');
        expect(root.getAttribute('data-app-badgelist-look')).toBe('outline');

        const open = badgeOf(utils, 'Open');
        expect(open.style.background).toBe('transparent');
        expect(open.style.borderColor.toLowerCase()).toBe('currentcolor');
        expect(open.getAttribute('data-badge-role')).toBe('success');

        const unmapped = badgeOf(utils, 'Unmapped');
        expect(unmapped.style.background).toBe('transparent');
        expect(unmapped.style.borderColor).toBe('var(--border-default)');
        expect(unmapped.style.color).toBe('var(--text-secondary)');
    });
});

describe('AppBadgeList — look: solid', () => {
    it('fills the pill with the role color and pairs it with contrast text', () => {
        const utils = withRuntime(<AppBadgeList node={node({ look: 'solid' })} />);
        const root = utils.container.querySelector('[data-app-badgelist]');
        expect(root.getAttribute('data-app-badgelist-look')).toBe('solid');

        // success is a fixed status hex → roleFillContrast's near-black text.
        const open = badgeOf(utils, 'Open');
        expect(open.style.background).toBe('rgb(16, 185, 129)');
        expect(open.style.color).toBe('rgb(17, 24, 39)');
        expect(open.style.borderColor).toBe('transparent');
    });

    it('a solid primary pill uses the themes contrast token, never a guess', () => {
        const utils = withRuntime(<AppBadgeList node={node({ look: 'solid' })} />);
        const urgent = badgeOf(utils, 'Urgent');
        expect(urgent.style.background).toBe('var(--app-primary)');
        expect(urgent.style.color).toBe('var(--app-primary-contrast)');
    });

    it('an unmapped value becomes the inverted chip — tokens only, readable in every theme', () => {
        const utils = withRuntime(<AppBadgeList node={node({ look: 'solid' })} />);
        const unmapped = badgeOf(utils, 'Unmapped');
        expect(unmapped.style.background).toBe('var(--text-primary)');
        expect(unmapped.style.color).toBe('var(--bg-primary)');
    });

    it('a mapped NEUTRAL role also inverts: its role color is a theme-dependent text token, not a fill', () => {
        const utils = withRuntime(<AppBadgeList node={node({
            look: 'solid',
            colorMap: [{ value: 'open', color: 'neutral' }],
        })} />);
        const open = badgeOf(utils, 'Open');
        expect(open.style.background).toBe('var(--text-primary)');
        expect(open.style.color).toBe('var(--bg-primary)');
    });
});

describe('AppBadgeList — looks introduce no purple and no new hex', () => {
    it.each(['soft', 'outline', 'solid'])('%s look has no purple/violet/indigo', (look) => {
        const { container } = withRuntime(<AppBadgeList node={node({ look })} />);
        expect(container.innerHTML).not.toMatch(/indigo|violet|purple|#6366f1|#4f46e5|#818cf8|#7c3aed|#a855f7/i);
    });
});

/**
 * badge_list.activeWhen (spec: componentSpecs.js). A per-pill formula whose
 * truthy match forces that one pill solid (a visible filter state) while the
 * rest keep the component's `look`.
 */
describe('AppBadgeList — activeWhen forces the matching pill solid', () => {
    it('renders the matched pill solid and leaves the others in the base look', () => {
        const utils = withRuntime(<AppBadgeList node={node({ activeWhen: 'item.tone == "open"' })} />);

        // Open matches → solid success fill + contrast text, marked active.
        const open = badgeOf(utils, 'Open');
        expect(open.getAttribute('data-badge-active')).toBe('true');
        expect(open.style.background).toBe('rgb(16, 185, 129)');
        expect(open.style.color).toBe('rgb(17, 24, 39)');

        // Urgent does not match → still the soft identity swatch, not active.
        const urgent = badgeOf(utils, 'Urgent');
        expect(urgent.getAttribute('data-badge-active')).toBeNull();
        expect(urgent.style.background.toLowerCase()).toBe('color-mix(in srgb, currentcolor 12%, transparent)');
    });

    it('with no activeWhen every pill keeps the base look', () => {
        const utils = withRuntime(<AppBadgeList node={node()} />);
        expect(utils.container.querySelectorAll('[data-badge-active]')).toHaveLength(0);
    });
});
