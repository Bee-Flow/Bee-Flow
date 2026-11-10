import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { API_BASE } from '@/utils/helpers';
import { DataProvider } from '../DataContext';
import { AssetTransportProvider } from '../assets/assetTransport';
import AppImage from './AppImage';

type ImageNode = Parameters<typeof AppImage>[0]['node'];

function image(props: Record<string, unknown>): ImageNode {
    return { id: 'cmp_img00001', type: 'image', props: { alt: 'Logo', fit: 'cover', ...props }, style: { height: 'md' } } as ImageNode;
}

describe('AppImage with uploaded files', () => {
    it('an https source renders the same <img> as before', () => {
        render(<AppImage node={image({ src: 'https://example.com/a.png' })} />);
        const img = screen.getByAltText('Logo');
        expect(img).toHaveAttribute('src', 'https://example.com/a.png');
        expect([...img.attributes].map((a) => a.name).sort()).toEqual(['alt', 'class', 'src']);
    });

    it('asset:<id> resolves under the app of the data scope', () => {
        render(<DataProvider appId="app_1"><AppImage node={image({ src: 'asset:abc' })} /></DataProvider>);
        expect(screen.getByAltText('Logo')).toHaveAttribute('src', `${API_BASE}/api/studio-apps/app_1/assets/abc`);
    });

    it('on a public page it resolves under the page token', () => {
        render(
            <AssetTransportProvider publicToken="f00dfeed">
                <DataProvider appId="app_1"><AppImage node={image({ src: 'asset:abc' })} /></DataProvider>
            </AssetTransportProvider>,
        );
        expect(screen.getByAltText('Logo')).toHaveAttribute('src', `${API_BASE}/api/public-app/f00dfeed/assets/abc`);
    });

    it('srcFrom wins when it resolves to an image, and src stays the fallback', () => {
        const { rerender } = render(<DataProvider appId="app_1"><AppImage node={image({ src: 'https://example.com/a.png', srcFrom: { kind: 'static', value: 'asset:xyz' } })} /></DataProvider>);
        expect(screen.getByAltText('Logo')).toHaveAttribute('src', `${API_BASE}/api/studio-apps/app_1/assets/xyz`);
        rerender(<DataProvider appId="app_1"><AppImage node={image({ src: 'https://example.com/a.png', srcFrom: { kind: 'static', value: 'not a url' } })} /></DataProvider>);
        expect(screen.getByAltText('Logo')).toHaveAttribute('src', 'https://example.com/a.png');
    });

    it('an asset with nothing to address it by shows the placeholder', () => {
        render(<AppImage node={image({ src: 'asset:abc' })} />);
        expect(screen.getByRole('img', { name: 'Logo' }).tagName).toBe('DIV');
    });
});
