import { getSessionToken, isDemoMode, isNextcloudEmbed } from '@/utils/helpers';
import { apiUrl } from '@/api/typedRequest';

/**
 * App Studio assets on the web: the value `asset:<id>` (an uploaded logo, picture or font
 * of the app, server/appStudio/appAssets.mts) and the one place that turns it into a URL.
 *
 * The id rule is the server's (componentSpecs/valueTypes.js isAssetRef): 1..64 letters,
 * digits, `_` or `-`. Checked character by character, never with a pattern.
 */

const ASSET_PREFIX = 'asset:';
const ID_MAX = 64;
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-';

/** Where the page runs: the signed-in app (by its id) or a public page (by its token). */
export interface AssetTransport {
    appId?: string | null;
    publicToken?: string | null;
}

export function isAssetRef(value: unknown): value is string {
    if (typeof value !== 'string' || !value.startsWith(ASSET_PREFIX)) return false;
    const id = value.slice(ASSET_PREFIX.length);
    if (id.length < 1 || id.length > ID_MAX) return false;
    for (const ch of id) if (!ID_CHARS.includes(ch)) return false;
    return true;
}

export function assetIdOf(value: unknown): string | null {
    return isAssetRef(value) ? value.slice(ASSET_PREFIX.length) : null;
}

export function isHttpsUrl(value: unknown): value is string {
    return typeof value === 'string' && value.trim().toLowerCase().startsWith('https://');
}

/** An image value the runtime can show: an https URL or an asset reference. */
export function isImageValue(value: unknown): value is string {
    return isHttpsUrl(value) || isAssetRef(value);
}

/**
 * A BOUND image value (`srcFrom`) the runtime may load: an asset reference, or a plain https address
 * on a host the app's owner listed in `allowedLinkHosts` (set by a person; the builder cannot write
 * it). A bound value is only known when the screen renders, and can carry the viewer's own data, so
 * an address on any other host is never requested.
 */
export function isAllowedBoundImage(value: unknown, allowedHosts: unknown): value is string {
    if (isAssetRef(value)) return true;
    if (!isHttpsUrl(value)) return false;
    let url: URL;
    try { url = new URL(value.trim()); } catch { return false; }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    return Array.isArray(allowedHosts) && allowedHosts.includes(url.hostname.toLowerCase());
}

/**
 * The URL of `ref` for this transport, or null when it is not an asset reference or there is
 * nothing to address it by. apiUrl's API_BASE carries the Nextcloud proxy prefix inside Nextcloud.
 *   public page: /api/public-app/<token>/assets/<id>   (the page token; no visitor bearer needed)
 *   signed in:   /api/studio-apps/<appId>/assets/<id>
 */
export function assetUrl(ref: unknown, transport: AssetTransport): string | null {
    const id = assetIdOf(ref);
    if (!id) return null;
    if (transport.publicToken) return apiUrl('GET /api/public-app/{token}/assets/{assetId}', { params: { token: transport.publicToken, assetId: id } });
    if (transport.appId) return apiUrl('GET /api/studio-apps/{id}/assets/{assetId}', { params: { id: transport.appId, assetId: id } });
    return null;
}

/**
 * True when the bytes must be fetched (with the request's headers) and shown from a blob,
 * instead of linking the URL: a feature demo (no network: its transport answers), and the
 * Nextcloud embedding when the session travels in a header rather than a cookie. A public
 * page never needs it: its URL carries the credential.
 */
export function assetNeedsFetch(transport: AssetTransport): boolean {
    if (isDemoMode()) return true;
    return !transport.publicToken && isNextcloudEmbed() && !!getSessionToken();
}
