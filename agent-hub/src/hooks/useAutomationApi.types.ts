/** A reusable HTTP credential as the connections route lists it (never the secret). */
export interface HttpConnection {
    id: string;
    label?: string;
    kind?: string;
    /** 'lent' for a credential shared with the caller, 'own' for their own. */
    access?: 'own' | 'lent';
}
