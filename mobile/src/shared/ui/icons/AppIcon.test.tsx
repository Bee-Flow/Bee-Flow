/**
 * A stored icon value draws an icon or an emoji — never its own name as text.
 * (A web-made app with `icon: "LayoutGrid"` used to show the word.)
 */

import { render, screen } from '@testing-library/react-native';
import React from 'react';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { AppIcon, resolveAppIcon } from './AppIcon';
import { ACTIVE_STROKE, DEFAULT_STROKE, Icon, isIconName } from './Icon';

jest.setTimeout(30_000);

const NUDGE = { marginTop: 2 };

describe('resolveAppIcon', () => {
    it('draws a registry name as that icon', () => {
        expect(resolveAppIcon('LayoutGrid')).toEqual({ kind: 'icon', name: 'LayoutGrid' });
        // A web name Lucide has since renamed still resolves.
        expect(resolveAppIcon('HelpCircle')).toEqual({ kind: 'icon', name: 'HelpCircle' });
    });

    it('accepts kebab-case, as older mobile data and Lucide URLs spell it', () => {
        expect(resolveAppIcon('layout-grid')).toEqual({ kind: 'icon', name: 'LayoutGrid' });
        expect(resolveAppIcon(' message-square ')).toEqual({ kind: 'icon', name: 'MessageSquare' });
    });

    it('keeps an emoji as text', () => {
        expect(resolveAppIcon('📁')).toEqual({ kind: 'text', text: '📁' });
        expect(resolveAppIcon('🚀 ')).toEqual({ kind: 'text', text: '🚀' });
    });

    it("falls back to the caller's default, else the web's FALLBACK_ICON", () => {
        expect(resolveAppIcon(null, 'LayoutGrid')).toEqual({ kind: 'icon', name: 'LayoutGrid' });
        expect(resolveAppIcon('', 'Folder')).toEqual({ kind: 'icon', name: 'Folder' });
        expect(resolveAppIcon('NotALucideIcon')).toEqual({ kind: 'icon', name: 'HelpCircle' });
        expect(resolveAppIcon('NotALucideIcon', 'Globe')).toEqual({ kind: 'icon', name: 'Globe' });
    });
});

describe('isIconName', () => {
    it('answers for the registry only, not for Object.prototype', () => {
        expect(isIconName('Bot')).toBe(true);
        expect(isIconName('constructor')).toBe(false);
        expect(isIconName('bot')).toBe(false);
    });
});

describe('<AppIcon>', () => {
    it('renders an emoji as text and a name as a glyph', async () => {
        // Decorative, like every icon: hidden from the screen reader, so the
        // query has to ask for hidden elements.
        await renderWithProviders(<AppIcon name="📁" />);
        expect(screen.getByText('📁', { includeHiddenElements: true })).toBeTruthy();

        await renderWithProviders(<AppIcon name="LayoutGrid" />);
        expect(screen.queryByText('LayoutGrid', { includeHiddenElements: true })).toBeNull();
    });
});

describe('<Icon>', () => {
    it("uses the web nav's strokes", () => {
        expect(DEFAULT_STROKE).toBe(1.75);
        expect(ACTIVE_STROKE).toBe(2.25);
    });

    it('wraps the glyph only when it needs a view of its own', async () => {
        await render(<Icon name="Bot" size={20} color="#123456" />);
        expect(screen.toJSON()).toMatchObject({ props: { width: 20, height: 20 } });

        await render(<Icon name="Bot" testID="bot" style={NUDGE} />);
        expect(screen.getByTestId('bot')).toBeTruthy();
    });
});
