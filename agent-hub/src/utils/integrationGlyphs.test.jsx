import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { getIntegrationGlyph, renderIntegrationGlyph } from './integrationGlyphs';
import { INTEGRATION_META } from './integrationIcons';

describe('getIntegrationGlyph', () => {
    it('gives every Nextcloud app a glyph of its own, in the brand colour, by either id spelling', () => {
        const talk = getIntegrationGlyph('nextcloud-talk');
        expect(talk).toBeTruthy();
        expect(talk.color).toBe(INTEGRATION_META.nextcloud.color);
        expect(getIntegrationGlyph('nextcloud_talk').Icon).toBe(talk.Icon);
        // Files, the vendor's core app, is not stripped to the rings either.
        expect(getIntegrationGlyph('nextcloud')).toBeTruthy();
        // No two Nextcloud apps share a glyph — that was the whole problem.
        const ids = ['nextcloud', 'nextcloud-talk', 'nextcloud-calendar', 'nextcloud-deck', 'nextcloud-tables', 'nextcloud-forms', 'nextcloud-mail',
            'nextcloud-tasks', 'nextcloud-notes', 'nextcloud-contacts', 'nextcloud-teams', 'nextcloud-notifications', 'nextcloud-activity', 'nextcloud-status'];
        const icons = ids.map(id => getIntegrationGlyph(id)?.Icon);
        expect(icons.every(Boolean)).toBe(true);
        expect(new Set(icons).size).toBe(ids.length);
    });

    it('knows nothing about apps that have a logo each', () => {
        expect(getIntegrationGlyph('gmail')).toBeNull();
        expect(getIntegrationGlyph('outlook')).toBeNull();
        expect(getIntegrationGlyph(null)).toBeNull();
        expect(getIntegrationGlyph('')).toBeNull();
    });

    it('renders as a decorative, tinted lucide at the asked size', () => {
        const { container } = render(renderIntegrationGlyph(getIntegrationGlyph('nextcloud-deck'), 18, { className: 'x' }));
        const svg = container.querySelector('svg');
        expect(svg.getAttribute('width')).toBe('18');
        expect(svg.getAttribute('aria-hidden')).toBe('true');
        expect(svg.style.color).toBeTruthy();
        expect(svg.classList.contains('x')).toBe(true);
        expect(svg.classList.contains('lucide-square-kanban')).toBe(true);
    });
});
