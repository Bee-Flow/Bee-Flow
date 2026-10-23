import { useEffect, useState } from 'react';
import { errorCode } from '../../../../../utils/caughtError';
import { datatablesApi } from '../datatablesApi';

/** What the server says about linking Nextcloud tables right now. */
export interface Linkable {
    connected?: boolean;
    reason?: string;
    tables?: unknown[];
}

/** One storage a spreadsheet could come from, as the probe lists it. */
export interface StorageProbe {
    provider: string;
    connected?: boolean;
    reason?: string;
}

/**
 * What the dialog asks the server once on open: which Nextcloud tables and which
 * spreadsheet storages this account could link.
 */
export function useLinkSources(offerNextcloud: boolean, canChoose: boolean) {
    const [linkable, setLinkable] = useState<Linkable | null>(null);   // { connected, reason, tables } | null while loading
    useEffect(() => {
        if (!offerNextcloud) return undefined;
        let alive = true;
        datatablesApi.linkable(canChoose ? undefined : 'personal')
            .then(b => { if (alive) setLinkable(b || { connected: false, reason: 'nextcloud_unavailable', tables: [] }); })
            .catch(e => { if (alive) setLinkable({ connected: false, reason: errorCode(e) || 'nextcloud_unavailable', tables: [] }); });
        return () => { alive = false; };
    }, [offerNextcloud, canChoose]);
    // Which storages could a spreadsheet come from? Asked always (no client
    // pre-gate, see the header), answered cheaply, and never allowed to
    // break the dialog: [] is "no card".
    const [providers, setProviders] = useState<StorageProbe[] | null>(null);   // [{provider, connected, reason?}] | null while loading
    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const b = await datatablesApi.spreadsheetProviders(canChoose ? undefined : 'personal');
                if (alive) setProviders(Array.isArray(b?.providers) ? b.providers : []);
            } catch {
                if (alive) setProviders([]);
            }
        })();
        return () => { alive = false; };
    }, [canChoose]);
    return { linkable, providers };
}
