import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Characterisation of the settings nav ROWS — the presentation half of the
 * module. The routing half (ids, order, the phone subset as a real subset of
 * SETTINGS_TOP_LEVEL_TAB_IDS) is already frozen by
 * authedApp/settingsRoutes.test.js and is deliberately not repeated here.
 *
 * What is pinned instead is what a user actually sees for each addressable
 * section — the resolved English label and a rendered icon — plus the branch
 * that no shipped configuration reaches: an addressable segment with no
 * presentation row. That branch does not throw (a throw would take the whole
 * settings screen down); it logs and renders a placeholder, and the label it
 * places there is a key that is not in the catalogue.
 *
 * No i18n mock: t() resolves against the real EN catalogue, so the strings
 * asserted below are the strings on screen.
 */

import {
    MOBILE_EXTRA_TABS,
    MOBILE_VISIBLE_TOP_TABS,
    NAV_ITEMS,
    SETTINGS_DESKTOP_ONLY_TABS,
    SETTINGS_NAV_ROW_IDS,
} from './settingsNavItems';
import { useTranslation } from '../../hooks/useTranslation';

/** Resolve a labelKey exactly the way the sidebar does. */
function useT() {
    let t;
    const Probe = () => { ({ t } = useTranslation()); return null; };
    render(<Probe />);
    return t;
}

afterEach(() => { vi.resetModules(); vi.doUnmock('../../authedApp/settingsRoutes'); });

describe('settingsNavItems — the label a row shows', () => {
    it('resolves every row to its English label', () => {
        const t = useT();
        const labels = Object.fromEntries(NAV_ITEMS.map(i => [i.id, t(i.labelKey)]));
        expect(labels).toEqual({
            preferences: 'Preferences',
            appearance: 'Appearance',
            security: 'Security',
            memory: 'Memory',
            // The tab id and the word on screen differ here, in both
            // directions: the 'integrations' row reads "Connections", while
            // "Integrations" is the label of the ORG sub-item with id
            // 'org_integrations'.
            integrations: 'Connections',
            learning: 'Learning Center',
            help_support: 'Help & Support',
        });
    });

    it('gives every row a label key under the settings.* namespace', () => {
        expect(NAV_ITEMS.map(i => i.labelKey)).toEqual([
            'settings.preferences',
            'settings.appearance',
            'settings.security',
            'settings.memory',
            'settings.connections',
            'settings.learning_center',
            'settings.help_support',
        ]);
    });

    it('renders each row icon as a 15px svg', () => {
        for (const item of NAV_ITEMS) {
            const { container, unmount } = render(<div>{item.icon}</div>);
            const svg = container.querySelector('svg');
            expect(svg, `${item.id} has no renderable icon`).toBeTruthy();
            expect(svg.getAttribute('width')).toBe('15');
            expect(svg.getAttribute('height')).toBe('15');
            unmount();
        }
    });

    it('carries nothing but id, labelKey and icon — routing is not repeated on the row', () => {
        for (const item of NAV_ITEMS) {
            expect(Object.keys(item).sort()).toEqual(['icon', 'id', 'labelKey']);
        }
        expect(SETTINGS_NAV_ROW_IDS).toContain('security');
        expect(SETTINGS_DESKTOP_ONLY_TABS).toEqual(['integrations', 'learning']);
        expect(MOBILE_VISIBLE_TOP_TABS).not.toContain('integrations');
    });

    /* The phone trim has a second half: ids a phone reaches that are not
     * top-level tabs at all. It exists for exactly one section — Compliance —
     * and the pair of assertions below is what keeps it that way: the extra id
     * must NOT be a top-level tab (otherwise it belongs in the list above and
     * the exception is dead weight), and it must not silently grow. */
    it('lets Compliance — and only Compliance — through as a non-top-level phone tab', () => {
        expect(MOBILE_EXTRA_TABS).toEqual(['org_compliance']);
        for (const id of MOBILE_EXTRA_TABS) {
            expect(MOBILE_VISIBLE_TOP_TABS).not.toContain(id);
            expect(SETTINGS_NAV_ROW_IDS).not.toContain(id);
        }
    });
});

describe('settingsNavItems — an addressable segment with no presentation row', () => {
    /** Rebuild the module against a doctored tab list. */
    async function buildWith(tabIds) {
        vi.resetModules();
        vi.doMock('../../authedApp/settingsRoutes', () => ({
            SETTINGS_TOP_LEVEL_TAB_IDS: tabIds,
        }));
        const errors = [];
        const spy = vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args.join(' ')); });
        const mod = await import('./settingsNavItems');
        spy.mockRestore();
        return { mod, errors };
    }

    it('logs instead of throwing, and renders a placeholder row', async () => {
        const { mod, errors } = await buildWith(['preferences', 'ghost_section']);

        // Importing does NOT throw: a throw here takes the whole settings
        // screen down, which is worse than one visibly wrong row.
        expect(mod.NAV_ITEMS.map(i => i.id)).toEqual(['preferences', 'ghost_section']);
        expect(errors).toEqual([
            "[Settings] 'ghost_section' is addressable but has no nav row — add one in settingsNavItems.jsx",
        ]);

        const ghost = mod.NAV_ITEMS[1];
        expect(ghost.labelKey).toBe('settings.ghost_section');
        const { container } = render(<div>{ghost.icon}</div>);
        expect(container.querySelector('svg')).toBeTruthy();
    });

    it('shows the placeholder row as a raw key on screen (wart)', async () => {
        // The derived key `settings.<id>` is not in the catalogue, so t()
        // falls all the way through to the key itself — the placeholder row
        // reads "settings.ghost_section" in the sidebar, in every language.
        const { mod } = await buildWith(['preferences', 'ghost_section']);
        const t = useT();
        expect(t(mod.NAV_ITEMS[1].labelKey)).toBe('settings.ghost_section');
    });

    it('keeps the phone subset derived from the doctored list too', async () => {
        const { mod } = await buildWith(['preferences', 'integrations', 'ghost_section']);
        // Unknown ids stay visible on a phone: the subtraction only removes
        // the two named desktop-only tabs.
        expect(mod.MOBILE_VISIBLE_TOP_TABS).toEqual(['preferences', 'ghost_section']);
    });
});
