import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PublicAppPage from './PublicAppPage';

/**
 * The public page (/p/<token>) with a URL per screen. Its definition holds
 * only the screens the owner made public, so a link can open those and
 * nothing else; the transport, renderer and action runner are the real ones.
 */

function screenOf(id: string, children: unknown[]) {
    return {
        id, name: id, icon: null, showInNav: true, maxWidth: 'medium',
        sections: [{ id: `sec_${id.slice(4)}`, style: { padding: 4, gap: 3, background: 'none' }, children }],
    };
}

const PUBLIC_DEFINITION = {
    schemaVersion: 2,
    meta: { name: 'Intake', description: '', icon: 'LayoutGrid' },
    theme: { primary: '#1D4ED8', radius: 'md', density: 'comfortable', fontScale: 'md', appearance: 'light' },
    homeScreenId: 'scr_pub001',
    screens: [
        screenOf('scr_pub001', [
            { id: 'cmp_h00001', type: 'heading', visible: true, props: { text: 'Start here', level: 2 }, style: { span: 12 } },
            { id: 'cmp_next01', type: 'button', visible: true, onClick: 'act_next01', props: { label: 'Next', variant: 'primary', role: 'button' }, style: { span: 3 } },
        ]),
        screenOf('scr_pub002', [
            { id: 'cmp_h00002', type: 'heading', visible: true, props: { text: 'Thank you', level: 2 }, style: { span: 12 } },
        ]),
    ],
    actions: { act_next01: { kind: 'navigate', screenId: 'scr_pub002' } },
};

beforeEach(() => {
    window.history.replaceState(null, '', '/p/t1');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        json: async () => (String(url).includes('/api/public-app/t1') && !String(url).includes('/api/public-app/t1/')
            ? { visitorToken: 'v1', entryScreenId: 'scr_pub001', definition: PUBLIC_DEFINITION, app: { id: 'app-1', name: 'Intake' } }
            : {}),
    })));
});

afterEach(() => vi.unstubAllGlobals());

function shownScreen(container: HTMLElement) {
    return container.querySelector('[data-app-screen]')?.getAttribute('data-app-screen') ?? null;
}

describe('PublicAppPage — a URL per screen', () => {
    it('a navigate writes the screen into the URL and Back returns to the entry screen', async () => {
        const user = userEvent.setup();
        const { container } = render(<PublicAppPage token="t1" />);
        await user.click(await screen.findByRole('button', { name: 'Next' }));
        await screen.findByRole('heading', { name: 'Thank you' });
        expect(window.location.pathname).toBe('/p/t1');
        expect(window.location.hash).toBe('#/s/scr_pub002');

        await act(async () => {
            const moved = new Promise((resolve) => { window.addEventListener('popstate', resolve, { once: true }); });
            window.history.back();
            await moved;
        });
        await waitFor(() => expect(shownScreen(container)).toBe('scr_pub001'));
    });

    it('a link opens one of the public screens', async () => {
        window.history.replaceState(null, '', '/p/t1#/s/scr_pub002');
        const { container } = render(<PublicAppPage token="t1" />);
        expect(await screen.findByRole('heading', { name: 'Thank you' })).toBeTruthy();
        expect(shownScreen(container)).toBe('scr_pub002');
    });

    it('a link to a screen this page was not served opens the entry screen and drops the fragment', async () => {
        window.history.replaceState(null, '', '/p/t1#/s/scr_backoffice');
        const { container } = render(<PublicAppPage token="t1" />);
        await screen.findByRole('heading', { name: 'Start here' });
        expect(shownScreen(container)).toBe('scr_pub001');
        await waitFor(() => expect(window.location.hash).toBe(''));
    });
});
