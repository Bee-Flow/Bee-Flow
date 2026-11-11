/**
 * The stored n8n API key goes only to the stored n8n address
 * (routes/ai/config/integrations.js, /ai/n8n/test and PUT /ai/n8n/config).
 *
 *   - n8nTestTarget: the connection test may try a typed address, but then
 *     with a typed key; the stored key is only used with the stored address.
 *   - urlChangeDropsKey: saving another address without a new key drops the
 *     stored key, so it can never be sent to the new address later.
 *
 * Addresses are compared as typed, without surrounding space and trailing
 * slashes (plain string operations: the input is request text).
 */

export const N8N_KEY_NEEDED = 'Enter the API key to test a different n8n address.';

/** An address as compared and used: surrounding space and trailing slashes removed; '' for none. */
export function n8nAddress(url: unknown): string {
    let s = typeof url === 'string' ? url.trim() : '';
    while (s.endsWith('/')) s = s.slice(0, -1);
    return s;
}

export interface N8nTyped { n8nUrl?: string | null; apiKey?: string | null }
export interface N8nTestTarget {
    /** The address to test ('' when neither one was typed nor one is stored). */
    url: string;
    /** The typed key; '' means the stored key is the one to use. */
    typedKey: string;
    /** A typed address that differs from the stored one, without a typed key. */
    keyNeeded: boolean;
}

/** What the connection test talks to: the typed values, else the stored ones, never the stored key with another address. */
export function n8nTestTarget(typed: N8nTyped, storedUrl: unknown): N8nTestTarget {
    const typedUrl = n8nAddress(typed.n8nUrl);
    const stored = n8nAddress(storedUrl);
    const typedKey = typeof typed.apiKey === 'string' ? typed.apiKey.trim() : '';
    const otherAddress = typedUrl !== '' && typedUrl !== stored;
    return { url: typedUrl || stored, typedKey, keyNeeded: otherAddress && typedKey === '' };
}

/** Whether a save changes the address without bringing a new key: the stored key is then dropped. */
export function urlChangeDropsKey(typed: N8nTyped, storedUrl: unknown): boolean {
    if (typed.n8nUrl === undefined) return false;
    const typedKey = typeof typed.apiKey === 'string' ? typed.apiKey.trim() : '';
    return typedKey === '' && n8nAddress(typed.n8nUrl) !== n8nAddress(storedUrl);
}
