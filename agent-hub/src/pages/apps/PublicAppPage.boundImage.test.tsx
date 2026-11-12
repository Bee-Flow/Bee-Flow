import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PublicAppPage from './PublicAppPage';

// A public page follows the app's rule for bound images: an https address loads only from a host
// in the app's allowedLinkHosts, which the server ships with the public definition.

afterEach(() => vi.unstubAllGlobals());

function servePublicApp(src: string, allowedLinkHosts?: string[]) {
    const image = { id: 'cmp_img00001', type: 'image', props: { alt: 'Photo', srcFrom: { kind: 'static', value: src } }, style: { span: 12 } };
    const payload = {
        visitorToken: 'v1',
        entryScreenId: 's1',
        app: { id: 'app_1', name: 'Intake' },
        definition: {
            schemaVersion: 3,
            meta: { name: 'Intake' },
            homeScreenId: 's1',
            screens: [{ id: 's1', name: 'Home', sections: [{ id: 'sec_1', children: [image] }] }],
            actions: {},
            ...(allowedLinkHosts ? { allowedLinkHosts } : {}),
        },
    };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => payload })));
}

describe('PublicAppPage bound images', () => {
    it('renders a bound https image on a listed host', async () => {
        servePublicApp('https://cdn.example.org/p.png', ['cdn.example.org']);
        render(<PublicAppPage token="t1" />);
        const img = await screen.findByAltText('Photo');
        expect(img.tagName).toBe('IMG');
        expect(img).toHaveAttribute('src', 'https://cdn.example.org/p.png');
    });

    it('renders the placeholder for a host that is not listed', async () => {
        servePublicApp('https://track.example/p.png', ['cdn.example.org']);
        const { container } = render(<PublicAppPage token="t1" />);
        const shown = await screen.findByRole('img', { name: 'Photo' });
        expect(shown.tagName).toBe('DIV');
        expect(container.querySelector('img')).toBeNull();
    });
});
