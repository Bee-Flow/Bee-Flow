/** A reusable HTTP credential as the connections route lists it (never the secret). */
export interface HttpConnection {
    id: string;
    label?: string;
    /** Always set for provider 'http': the server rejects a credential without a valid kind (sanitizeHttpSecret). */
    kind: string;
    /** 'lent' for a credential shared with the caller, 'own' for their own. */
    access?: 'own' | 'lent';
}
