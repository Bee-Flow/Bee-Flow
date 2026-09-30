/** What one connector's `/status` answer means for its row. */

import type { Connector } from './catalog';
import type { IntegrationStatus } from './types';

export interface ConnectorState {
    /** Who it is linked as, when the provider says. */
    identity: string | null;
    /**
     * The admin has not set this provider's client id and secret. Without the
     * provider reporting it, "not connected" and "impossible to connect" look
     * identical, and the user hunts for a button that can never work.
     */
    notConfigured: boolean;
    needsReauth: boolean;
    connected: boolean;
}

export function connectorState(connector: Connector, status: IntegrationStatus | null): ConnectorState {
    const field = connector.identityField;
    return {
        identity: field && status ? (status[field] ?? null) : null,
        notConfigured: connector.reportsConfigured && status?.configured === false,
        needsReauth: Boolean(status?.needsReauth),
        connected: Boolean(status?.connected),
    };
}
