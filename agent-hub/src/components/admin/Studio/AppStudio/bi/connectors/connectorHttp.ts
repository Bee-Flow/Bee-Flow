/**
 * The connector routes the connectors editor and the sync panel call, in one
 * place: run (Test it), verify (a mailbox's Check access), inspect and sync
 * (keep this in a table), and the sync status list. Every one of them resolves
 * the connector from the LAST SAVED owner model.
 */
import { API_BASE, authFetch } from '../../../../../../utils/helpers';

function connectorsUrl(appId: string): string {
    return `${API_BASE}/api/studio-apps/${encodeURIComponent(appId)}/data/connectors`;
}

/** POST /data/connectors/:id/<action> with an already-serialised JSON body. */
export function postConnector(appId: string, connectorId: string, action: string, body: string): Promise<Response> {
    return authFetch(
        `${connectorsUrl(appId)}/${encodeURIComponent(connectorId)}/${action}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
    );
}

/** GET /data/connectors/sync-status — the last run of every syncing connector. */
export function getSyncStatus(appId: string): Promise<Response> {
    return authFetch(`${connectorsUrl(appId)}/sync-status`);
}
