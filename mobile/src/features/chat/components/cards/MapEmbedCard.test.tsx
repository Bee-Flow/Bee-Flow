/**
 * A tool's map opens Maps on the place or route, never the Embed API page: a
 * place search comes with no Maps link, only an iframe URL carrying the org's
 * key, and the card reads the query back out of it instead.
 */

import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';
import { Linking } from 'react-native';

import { mapEmbedLink } from '@/features/chat/model/mapEmbed';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import { MapEmbedCard } from './MapEmbedCard';

const SEARCH = {
    embedUrl: 'https://www.google.com/maps/embed/v1/search?key=SECRET&q=pharmacy%20near%20Utrecht',
    title: 'Search: pharmacy near Utrecht',
    mapsLink: null as unknown as undefined,
};
const SEARCH_LINK = 'https://www.google.com/maps/search/?api=1&query=pharmacy%20near%20Utrecht';

let openURL: jest.SpyInstance;
beforeEach(() => {
    openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
});
afterEach(() => openURL.mockRestore());

describe('mapEmbedLink', () => {
    it("keeps the tool's own Maps link", () => {
        expect(mapEmbedLink({ ...SEARCH, mapsLink: 'https://www.google.com/maps/dir/A/B' })).toBe('https://www.google.com/maps/dir/A/B');
    });

    it('turns a place search into a Maps search, without the key', () => {
        expect(mapEmbedLink(SEARCH)).toBe(SEARCH_LINK);
    });

    it('turns a directions embed into a Maps route', () => {
        const route = { embedUrl: 'https://www.google.com/maps/embed/v1/directions?key=K&origin=Utrecht&destination=Gouda&mode=driving' };
        expect(mapEmbedLink(route)).toBe(
            'https://www.google.com/maps/dir/?api=1&origin=Utrecht&destination=Gouda&travelmode=driving',
        );
    });

    it('has nothing to open for an embed that names no place', () => {
        expect(mapEmbedLink({ embedUrl: 'not a url' })).toBeNull();
        expect(mapEmbedLink({ mapsLink: 'javascript:alert(1)' })).toBeNull();
    });
});

it('opens Maps on the searched place, not the embed', async () => {
    await renderScreen(<MapEmbedCard map={SEARCH} />);
    await fireEvent.press(screen.getByText('Open in Maps'));
    expect(openURL).toHaveBeenCalledWith(SEARCH_LINK);
});

it('draws no button when there is nothing to open', async () => {
    await renderScreen(<MapEmbedCard map={{ embedUrl: 'https://www.google.com/maps/embed/v1/search?key=K', title: 'Map' }} />);
    expect(screen.queryByText('Open in Maps')).toBeNull();
});

it('says so when the phone cannot open Maps', async () => {
    openURL.mockRejectedValue(new Error('No activity found'));
    await renderScreen(<MapEmbedCard map={SEARCH} />);
    await fireEvent.press(screen.getByText('Open in Maps'));
    expect(await screen.findByText('Maps could not be opened on this phone.')).toBeTruthy();
});
