import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PublicAppPage from './PublicAppPage';

afterEach(() => vi.unstubAllGlobals());

function servePublicApp(design: Record<string, unknown> | undefined) {
    const payload = {
        visitorToken: 'v1',
        entryScreenId: 's1',
        app: { id: 'app_1', name: 'Intake' },
        definition: {
            meta: { name: 'Intake' },
            design,
            screens: [{ id: 's1', name: 'Home', sections: [] }],
        },
    };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => payload })));
}

describe('PublicAppPage logo', () => {
    it('draws the page logo when the served design carries one', async () => {
        servePublicApp({ logoUrl: 'https://example.com/logo.png' });
        const { container } = render(<PublicAppPage token="t1" />);
        const img = await screen.findByAltText('Intake');
        expect(img).toHaveAttribute('src', 'https://example.com/logo.png');
        expect(container.querySelector('[data-app-public-logo]')).not.toBeNull();
    });

    it('draws nothing extra when no logo is set', async () => {
        servePublicApp(undefined);
        const { container } = render(<PublicAppPage token="t1" />);
        await vi.waitFor(() => expect(screen.queryByRole('status')).toBeNull());
        expect(container.querySelector('[data-app-public-logo]')).toBeNull();
        expect(container.querySelector('img')).toBeNull();
    });
});
