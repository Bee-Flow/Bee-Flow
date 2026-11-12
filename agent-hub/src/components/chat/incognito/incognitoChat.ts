/**
 * Incognito chat, the parts without a component: the session id, the model
 * tiers it offers and the frame it draws around the chat pane.
 *
 * Incognito keeps nothing: the server stores no conversation, the messages
 * live in the open tab's React state only, and the chat ends the moment it is
 * no longer the active one (useIncognitoSession).
 */

/** Tiers that run something stored next to the conversation, which incognito has none of. */
const INCOGNITO_UNAVAILABLE_TIERS = new Set(['swarm']);

/** The tiers an incognito chat offers: every tier except the ones it cannot run. */
export function incognitoModelTiers<T extends Record<string, unknown>>(tiers: T | null | undefined): T | null | undefined {
    if (!tiers) return tiers;
    return Object.fromEntries(Object.entries(tiers).filter(([key]) => !INCOGNITO_UNAVAILABLE_TIERS.has(key))) as T;
}

/** Whether a tier is available in an incognito chat. */
export function incognitoAllowsTier(tier: string | null | undefined): boolean {
    return !tier || !INCOGNITO_UNAVAILABLE_TIERS.has(tier);
}

/**
 * A random v4 UUID for one incognito session. `crypto.randomUUID` needs a
 * secure context, and a self-hosted instance on a plain-http LAN address is
 * not one; `getRandomValues` works everywhere.
 */
export function newIncognitoSessionId(): string {
    const c = globalThis.crypto;
    if (typeof c?.randomUUID === 'function') return c.randomUUID();
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const hex = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The frame around the chat pane while incognito is on: dashed, on the theme's own tokens. */
export const INCOGNITO_FRAME_CLASS = 'rounded-xl outline-2 outline-dashed -outline-offset-4 outline-[var(--text-tertiary)]';
