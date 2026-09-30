/** The drawer is Studio's menu on the Studio tab, and the chat sidebar everywhere else. */

import { drawerMenuFor } from './drawerMenu';
import { TABS, tabPathOf } from './tabs';

describe('drawerMenuFor', () => {
    it('gives the Studio tab the Studio menu, and the other tabs the chat sidebar', () => {
        expect(Object.fromEntries(TABS.map((tab) => [tab.name, drawerMenuFor(tab.path)]))).toEqual({
            index: 'chat',
            record: 'chat',
            studio: 'studio',
        });
    });

    it('reads the tab the drawer holds, so a screen pushed over it does not switch menus', () => {
        const drawer = (tab: string) => ({ index: 0, routes: [{ name: '(tabs)', state: { index: 0, routes: [{ name: tab }] } }] });
        expect(drawerMenuFor(tabPathOf(drawer('studio')))).toBe('studio');
        expect(drawerMenuFor(tabPathOf(drawer('index')))).toBe('chat');
        expect(drawerMenuFor(tabPathOf(undefined))).toBe('chat');
    });

    it('never treats a Studio screen outside the tab as the tab', () => {
        expect(drawerMenuFor('/studio/search')).toBe('chat');
        expect(drawerMenuFor('')).toBe('chat');
    });
});
