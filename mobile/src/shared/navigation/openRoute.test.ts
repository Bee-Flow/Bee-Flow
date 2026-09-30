/** Which router call an address gets: a tab root is switched to, never stacked. */

import { isDrawerPath, openRoute, routePath, type RouteOpener } from './openRoute';

function fakeRouter(canDismiss: boolean): RouteOpener & Record<'push' | 'navigate' | 'dismissTo', jest.Mock> {
    return { push: jest.fn(), navigate: jest.fn(), dismissTo: jest.fn(), canDismiss: () => canDismiss };
}

describe('routePath', () => {
    it('drops route groups, the query, the hash and a trailing slash', () => {
        expect(routePath('/(tabs)/record?x=1')).toBe('/record');
        expect(routePath('/(tabs)')).toBe('/');
        expect(routePath('/(drawer)/(tabs)/studio/')).toBe('/studio');
        expect(routePath('/chat/abc#top')).toBe('/chat/abc');
        expect(routePath('/')).toBe('/');
    });
});

describe('isDrawerPath', () => {
    it('is true for the tab roots only', () => {
        for (const href of ['/', '/studio', '/record', '/(tabs)/record', '/studio?x=1']) {
            expect(isDrawerPath(href)).toBe(true);
        }
        for (const href of ['/cowork', '/apps', '/apps/1', '/studio/search', '/chat/1', '/recordings/1', '/search']) {
            expect(isDrawerPath(href)).toBe(false);
        }
    });
});

describe('openRoute', () => {
    it('pops back to the drawer for a tab when a screen is pushed over it', () => {
        const router = fakeRouter(true);
        openRoute(router, '/studio');
        expect(router.dismissTo).toHaveBeenCalledWith('/studio');
        expect(router.push).not.toHaveBeenCalled();
        expect(router.navigate).not.toHaveBeenCalled();
    });

    it('switches the tab from inside the drawer', () => {
        const router = fakeRouter(false);
        openRoute(router, '/(tabs)/record');
        expect(router.navigate).toHaveBeenCalledWith('/(tabs)/record');
        expect(router.dismissTo).not.toHaveBeenCalled();
    });

    it('pushes every other address, wherever it is opened from', () => {
        for (const canDismiss of [true, false]) {
            const router = fakeRouter(canDismiss);
            openRoute(router, '/approvals/7');
            expect(router.push).toHaveBeenCalledWith('/approvals/7');
            expect(router.dismissTo).not.toHaveBeenCalled();
        }
    });
});
