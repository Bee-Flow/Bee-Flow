/** The bottom bar: up to three tabs, each a real route file. */

import fs from 'node:fs';
import path from 'node:path';

import { DRAWER_PATHS } from '@/shared/navigation';

import { TAB_PATHS, TABS, tabPathOf, tabShown, type TabOffer } from './tabs';

const TABS_DIR = path.resolve(__dirname, '../../../../app/(drawer)/(tabs)');

const shown = (offer: TabOffer) => TABS.filter((tab) => tabShown(tab, offer)).map((tab) => tab.name);

describe('the tabs', () => {
    it('always carries Chat and Studio, and Meeting Notes behind its gate', () => {
        expect(shown({ record: true })).toEqual(['index', 'record', 'studio']);
        expect(shown({ record: false })).toEqual(['index', 'studio']);
    });

    it('declares a route file for every tab, and no tab file it does not declare', () => {
        const files = fs
            .readdirSync(TABS_DIR)
            .filter((f) => f.endsWith('.tsx') && !f.startsWith('_'))
            .map((f) => f.replace(/\.tsx$/, ''))
            .sort();
        expect(files).toEqual(TABS.map((tab) => tab.name).sort());
    });

    it('gives each tab its URL, the set shared/navigation treats as the drawer', () => {
        for (const tab of TABS) expect(tab.path).toBe(tab.name === 'index' ? '/' : `/${tab.name}`);
        expect([...TAB_PATHS]).toEqual(['/', '/record', '/studio']);
        expect([...TAB_PATHS]).toEqual([...DRAWER_PATHS]);
    });
});

describe('tabPathOf', () => {
    it('reads the focused tab out of the drawer navigator’s state', () => {
        const drawer = (tabs?: { index?: number; routes: { name: string }[] }) => ({
            index: 0,
            routes: [{ name: '(tabs)', state: tabs }],
        });
        expect(tabPathOf(drawer({ index: 1, routes: [{ name: 'index' }, { name: 'studio' }, { name: 'record' }] }))).toBe('/studio');
        // Not rehydrated yet (a deep link): the last route is the focused one.
        expect(tabPathOf(drawer({ routes: [{ name: 'record' }] }))).toBe('/record');
        expect(tabPathOf(drawer())).toBe('/');
        expect(tabPathOf(undefined)).toBe('/');
    });
});
