/**
 * Run: cd agent-hub && npx vitest run src/marketing/components/IconGlyph.test.tsx --maxWorkers=2
 */
import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import IconGlyph, { iconAssetSrc } from './IconGlyph';

describe('iconAssetSrc', () => {
    it('accepts an uploaded-asset key or route and resolves it', () => {
        expect(iconAssetSrc('cms/shield.svg')).toBe('/api/cms/asset/cms/shield.svg');
        expect(iconAssetSrc('/api/cms/asset/cms/shield.svg')).toBe('/api/cms/asset/cms/shield.svg');
    });

    it('rejects other origins, other paths, traversal, whitespace and Lucide names', () => {
        for (const bad of ['https://x.example/i.svg', '//evil.example/i.svg', '/other/i.svg', 'cms/../x.svg', 'cms/a b.svg', 'javascript:alert(1)', 'Shield', '', undefined]) {
            expect(iconAssetSrc(bad), String(bad)).toBeNull();
        }
    });
});

describe('IconGlyph', () => {
    it('renders an uploaded asset as a decorative image', () => {
        const { container } = render(<IconGlyph icon="cms/shield.svg" />);
        const img = container.querySelector('img');
        expect(img?.getAttribute('src')).toBe('/api/cms/asset/cms/shield.svg');
        expect(img?.getAttribute('alt')).toBe('');
    });

    it('renders a Lucide name as an svg', () => {
        const { container } = render(<IconGlyph icon="ShieldCheck" />);
        expect(container.querySelector('svg')).toBeTruthy();
        expect(container.querySelector('img')).toBeNull();
    });

    it('renders nothing for a foreign address, never an img pointing at it', () => {
        const { container } = render(<IconGlyph icon="//evil.example/i.svg" />);
        expect(container.querySelector('img')).toBeNull();
        expect(container.textContent).toBe('');
    });

    it('shows legacy text (an emoji) only when asked to', () => {
        expect(render(<IconGlyph icon={'\u{1F41D}'} legacyText />).container.textContent).toBe('\u{1F41D}');
        expect(render(<IconGlyph icon={'\u{1F41D}'} />).container.textContent).toBe('');
    });
});
