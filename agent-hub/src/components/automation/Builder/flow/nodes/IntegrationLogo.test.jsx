import { render, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import IntegrationLogo from './IntegrationLogo';

// The icon pack is a context with a provider-less default of "no overrides";
// one test needs an override, so the hook is mockable per test.
const custom = vi.fn(() => null);
vi.mock('../../../../../hooks/useIconPack', () => ({
    useIconPack: () => ({ getCustomIcon: (key) => custom(key), activePackId: null, setIconPack: async () => {}, isLoading: false, reload: () => {} }),
}));

describe('IntegrationLogo', () => {
    afterEach(() => { cleanup(); custom.mockReset(); custom.mockImplementation(() => null); });

    it('draws a Nextcloud app with its own glyph rather than the shared rings — from the id or the tool name', () => {
        const { container } = render(<IntegrationLogo integrationId="nextcloud-talk" size={16} />);
        expect(container.querySelector('svg.lucide-messages-square')).toBeTruthy();
        cleanup();
        const byTool = render(<IntegrationLogo tool="nextcloud_deck_create_card" size={16} />);
        expect(byTool.container.querySelector('svg.lucide-square-kanban')).toBeTruthy();
    });

    it('keeps the brand SVG for an app that has one of its own', () => {
        const { container } = render(<IntegrationLogo integrationId="gmail" size={16} />);
        expect(container.querySelector('svg')).toBeTruthy();
        expect(container.querySelector('svg.lucide')).toBeNull();
    });

    it('a white-label icon-pack override still wins over the glyph', () => {
        custom.mockImplementation((key) => (key === 'integration.nextcloud_talk' ? { type: 'image', value: '/icons/talk.png' } : null));
        const { container } = render(<IntegrationLogo integrationId="nextcloud-talk" size={16} />);
        expect(container.querySelector('img')?.getAttribute('src')).toBe('/icons/talk.png');
        expect(container.querySelector('svg')).toBeNull();
    });

    it('falls back to the caller\'s icon for an app with no mark at all', () => {
        const { container } = render(<IntegrationLogo integrationId="no-such-app" size={16} fallback={<i data-fb="" />} />);
        expect(container.querySelector('[data-fb]')).toBeTruthy();
    });
});
