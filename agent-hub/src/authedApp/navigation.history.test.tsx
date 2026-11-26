/**
 * The navigation contract, part two: the navigation call and Back/Forward.
 *
 * For every row of INVENTORY (navigationInventory.ts) that a navigation call
 * reaches: from the home page, the call (the `onNavigate` the app hands its
 * pages) writes the row's address and shows its page; Back returns to the home
 * page and Forward to the page again, both through popstate. Then the history
 * edges. Part one (navigation.deepLinks.test.tsx) is the cold load.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOME, MEMBER, QUICK, WAIT, back, bootAt, expectAt, expectShows, forward, onAPhone } from './navigationHarness';
import { APP_ID, INVENTORY, landing } from './navigationInventory';

afterEach(() => { vi.unstubAllGlobals(); });

describe('the navigation call writes the address; Back and Forward return', () => {
    for (const row of INVENTORY.filter(r => r.nav && r.url !== '/app')) {
        const fails = row.fails?.nav;
        const wait = fails ? QUICK : WAIT;
        const target = row.navUrl ?? landing(row);
        (fails ? it.fails : it)(`navigateToPage('${row.nav}') → ${target}${fails ? ` (fails: ${fails})` : ''}`, async () => {
            const app = await bootAt('/app');
            app.navigate(row.nav!);
            await expectAt(target, wait);
            await expectShows(row.shows, wait);
            await back();
            await expectAt('/app', wait);
            await expectShows(HOME, wait);
            await forward();
            await expectAt(target, wait);
            await expectShows(row.shows, wait);
        });
    }
});

describe('the history edges', () => {
    it("'home' from another page writes /app, and Back returns", async () => {
        const app = await bootAt('/app/cowork', { testId: 'cowork-page' });
        app.navigate('home');
        await expectAt('/app');
        await expectShows(HOME);
        await back();
        await expectAt('/app/cowork');
        await expectShows({ testId: 'cowork-page' });
    });

    it('a page of Cowork opened from the Cowork home has its own address; Back returns to the home, Forward to the page', async () => {
        await bootAt('/app/cowork', { testId: 'cowork-page' });
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: 'Ask Bee…' }));
        await user.click(await screen.findByRole('button', { name: 'Cowork preferences' }));
        await expectAt('/app/cowork/preferences');
        await expectShows({ testId: 'cowork-settings-panel' });
        expect(screen.queryByRole('dialog')).toBeNull();
        await back();
        await expectAt('/app/cowork');
        await waitFor(() => expect(screen.queryByTestId('cowork-settings-panel')).toBeNull());
        expect(screen.getByTestId('cowork-home')).toBeVisible();
        await forward();
        await expectAt('/app/cowork/preferences');
        await expectShows({ testId: 'cowork-settings-panel' });
    });

    it('a page key with no route writes "/" and shows the home page', async () => {
        const app = await bootAt('/app/cowork', { testId: 'cowork-page' });
        app.navigate('no-such-page');
        await expectAt('/');
        await expectShows(HOME);
    });

    it('Back and Forward move between two pages, not only to and from home', async () => {
        const app = await bootAt('/app/settings', { current: 'settings-nav-preferences' });
        app.navigate('studio/knowledge/kb1');
        await expectShows({ testId: 'kb-detail-page' });
        await back();
        await expectAt('/app/settings');
        await expectShows({ current: 'settings-nav-preferences' });
        await forward();
        await expectAt('/app/studio/knowledge/kb1');
        await expectShows({ testId: 'kb-detail-page' });
    });

    it('a member navigating to the admin dashboard gets its address and the access-denied page', async () => {
        const app = await bootAt('/app', HOME, { user: MEMBER });
        app.navigate('admin');
        await expectAt('/app/admin');
        await expectShows({ testId: 'admin-access-denied-whole' });
    });

    it('on a phone, navigating to a desktop-only page stays home', async () => {
        onAPhone();
        const app = await bootAt('/app/cowork', { testId: 'cowork-page' });
        app.navigate('admin');
        await expectAt('/app');
        await expectShows(HOME);
    });

    it('inside Nextcloud, Back between an embedded app\'s screens stays in the app', async () => {
        const root = `/exapps/bee_flow/?ncStudioApp=${APP_ID}`;
        await bootAt(root, { text: 'This app is not available to you' });
        window.history.pushState(null, '', `${root}&screen=2`);
        await back();
        await expectAt(root);
        await expectShows({ text: 'This app is not available to you' });
    });
});
