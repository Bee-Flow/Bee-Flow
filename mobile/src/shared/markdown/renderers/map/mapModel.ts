/**
 * A ```map fence: `{ embedUrl, title, mapsLink }`, as the web's
 * MapEmbedRenderer reads it (the maps tools write it). The web frames the
 * Google Maps Embed URL; a phone without a WebView reads what the embed
 * shows instead — a place, or a route from A to B — and opens Maps on it.
 */

export interface MapRoute {
    origin: string;
    destination: string;
    mode: string | null;
}

export interface MapData {
    /** '' when the tool gave none; the card then says "Map", as the web does. */
    title: string;
    /** What to open in Maps: the tool's own link, or one built from the embed. */
    mapsLink: string;
    place: string | null;
    route: MapRoute | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function parseUrl(url: string): URL | null {
    try {
        return new URL(url);
    } catch {
        return null;
    }
}

/** The embed's subject: `…/embed/v1/place?q=…` or `…/embed/v1/directions?origin=…&destination=…`. */
export function readEmbed(embedUrl: string): { place: string | null; route: MapRoute | null } {
    const url = parseUrl(embedUrl);
    if (!url) return { place: null, route: null };
    const get = (name: string) => url.searchParams.get(name)?.trim() || null;
    const origin = get('origin');
    const destination = get('destination');
    if (url.pathname.includes('/directions') && origin && destination) {
        return { place: null, route: { origin, destination, mode: get('mode') } };
    }
    return { place: get('q') ?? get('center'), route: null };
}

/** A Google Maps URL for the same place or route (the Maps URLs API, which the Maps app opens). */
export function mapsLinkFor(place: string | null, route: MapRoute | null): string | null {
    if (route) {
        const mode = route.mode ? `&travelmode=${encodeURIComponent(route.mode)}` : '';
        return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(route.origin)}&destination=${encodeURIComponent(route.destination)}${mode}`;
    }
    return place ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}` : null;
}

function isHttp(url: string): boolean {
    return /^https?:\/\//i.test(url);
}

export function readMap(source: string): MapData | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(source);
    } catch {
        return null;
    }
    if (!isRecord(parsed)) return null;
    const embedUrl = str(parsed.embedUrl);
    if (!embedUrl) return null; // the web draws nothing without one
    const { place, route } = readEmbed(embedUrl);
    const given = str(parsed.mapsLink);
    const mapsLink = given && isHttp(given) ? given : mapsLinkFor(place, route);
    if (!mapsLink) return null;
    return { title: str(parsed.title), mapsLink, place, route };
}
