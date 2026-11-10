import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_BASE } from '@/utils/helpers';
import PublicAppPage from './PublicAppPage';

afterEach(() => vi.unstubAllGlobals());

/** GET /api/public-app/:token as the server answers it: the page's own logo beside the definition. */
function servePublicApp(design: Record<string, unknown> | undefined, page?: { logoUrl: string | null }) {
    const payload = {
        visitorToken: 'v1',
        entryScreenId: 's1',
        app: { id: 'app_1', name: 'Intake' },
        definition: { meta: { name: 'Intake' }, design, screens: [{ id: 's1', name: 'Home', sections: [] }] },
        ...(page ? { page } : {}),
    };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => payload })));
}

describe('PublicAppPage logo', () => {
    it("draws the page's own logo", async () => {
        servePublicApp({ logoUrl: 'https://example.com/logo.png' }, { logoUrl: 'https://example.com/logo.png' });
        const { container } = render(<PublicAppPage token="t1" />);
        const img = await screen.findByAltText('Intake');
        expect(img).toHaveAttribute('src', 'https://example.com/logo.png');
        expect(container.querySelector('[data-app-public-logo]')).not.toBeNull();
    });

    it("never draws the app's own logo on a page that set none, so existing pages look the same", async () => {
        servePublicApp({ logoUrl: 'https://example.com/app-logo.png' }, { logoUrl: null });
        const { container } = render(<PublicAppPage token="t1" />);
        await vi.waitFor(() => expect(screen.queryByRole('status')).toBeNull());
        expect(container.querySelector('[data-app-public-logo]')).toBeNull();
        expect(container.querySelector('img')).toBeNull();
    });

    it('an uploaded page logo resolves under the page token, without a visitor bearer in the URL', async () => {
        servePublicApp(undefined, { logoUrl: 'asset:abc-1' });
        render(<PublicAppPage token="f00dfeed" />);
        const img = await screen.findByAltText('Intake');
        expect(img).toHaveAttribute('src', `${API_BASE}/api/public-app/f00dfeed/assets/abc-1`);
    });

    it('an older server that sends no page block draws no logo', async () => {
        servePublicApp({ logoUrl: 'https://example.com/app-logo.png' });
        const { container } = render(<PublicAppPage token="t1" />);
        await vi.waitFor(() => expect(screen.queryByRole('status')).toBeNull());
        expect(container.querySelector('[data-app-public-logo]')).toBeNull();
    });
});
