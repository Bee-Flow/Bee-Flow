/**
 * What a tool's map card opens.
 *
 * The maps tools send `{ embedUrl, title, mapsLink }`. A route and a single
 * place come with a Google Maps link, but a place SEARCH comes with
 * `mapsLink: null` and only the Embed API URL — a page made for an iframe,
 * which outside one is an error page, and which carries the org's Maps key.
 * So the embed is never opened itself: its place or route is read back out
 * (the same reading a ```map fence in an answer gets) and turned into a Maps
 * link, which Android hands to the Maps app. An embed that names nothing
 * leaves nothing to open.
 */

import { mapsLinkFor, readEmbed } from '@/shared/markdown';

import type { MapEmbed } from './types';

function isHttp(url: string): boolean {
    return /^https?:\/\//i.test(url);
}

/** A Google Maps link for the card, or null when there is nothing to open. */
export function mapEmbedLink(map: MapEmbed): string | null {
    const given = typeof map.mapsLink === 'string' ? map.mapsLink.trim() : '';
    if (given && isHttp(given)) return given;
    const { place, route } = readEmbed(map.embedUrl ?? '');
    return mapsLinkFor(place, route);
}
