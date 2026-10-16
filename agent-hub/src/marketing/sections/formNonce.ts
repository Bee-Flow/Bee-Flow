/**
 * The idempotency key of one form submission: 32 hex characters from the
 * CSPRNG. randomUUID where the context has it, getRandomValues otherwise
 * (a non-secure context lacks randomUUID); never Math.random.
 */
export function newFormNonce(cryptoApi: Crypto = globalThis.crypto): string {
    if (typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID().replace(/-/g, '');
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
