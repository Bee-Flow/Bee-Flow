import { createContext, createElement, useContext, useMemo, type ReactNode } from 'react';
import { useDataContext } from '../DataContext';
import type { AssetTransport } from './assetUrl';

/**
 * Which address an `asset:<id>` resolves to on this page. The public page provides its
 * token; everywhere else the app id of the data scope (DataContext) is the address.
 */
const PublicTokenContext = createContext<string | null>(null);

export function AssetTransportProvider({ publicToken, children }: { publicToken: string | null; children: ReactNode }) {
    return createElement(PublicTokenContext.Provider, { value: publicToken }, children);
}

/** The transport for this component; `appId` overrides the data scope's (the editor's panels have none). */
export function useAssetTransport(appId?: string | null): AssetTransport {
    const publicToken = useContext(PublicTokenContext);
    const scoped = useDataContext().appId;
    const id = appId ?? scoped ?? null;
    return useMemo(() => ({ appId: id, publicToken }), [id, publicToken]);
}
