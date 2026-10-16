import type { SyncBlock, SyncTableDraft } from './sync/syncModel';
import SyncSettings from './sync/SyncSettings';
import SyncSetup from './sync/SyncSetup';
import { useSyncActions } from './sync/useSyncActions';
import type { SyncConnector } from './sync/useSyncActions';
import useTranslation from '../../../../../hooks/useTranslation';

/**
 * App Studio — "keep this in a table".
 *
 * A connector without this fetches from the upstream API on every viewer, every
 * screen paint. With it, the rows land in one of the app's own tables and the
 * app reads locally; the upstream is touched once per refresh interval for the
 * whole audience.
 *
 * Setup is one click because the server already worked everything out. POST
 * /inspect runs the connector once and answers with the columns, the field that
 * identifies a row, and whether incremental loading is possible AT ALL — so this
 * panel proposes rather than asks (sync/SyncSetup). The owner confirms; nothing
 * is typed. Once set up, sync/SyncSettings holds the schedule and the last run.
 *
 * ── THE HONEST BIT ──────────────────────────────────────────────────
 * Incremental loading is only offered when the data supports it, and the copy
 * says which of the two kinds you get, because they are not equally good:
 *
 *   request — the action takes a "changed since" parameter, so only changed
 *             records are fetched. Genuinely cheaper upstream.
 *   client  — no such parameter exists, so everything is fetched and only
 *             changed rows are written. Cheaper for the database, NOT for the
 *             API. Saying otherwise would be a lie the owner discovers via a
 *             rate limit.
 *   none    — no timestamp anywhere; the option is not rendered at all.
 */
export interface ConnectorSyncPanelProps {
    connector: SyncConnector;
    tables?: Array<{ id: string; key?: string; name?: string }>;
    appId: string | null;
    onChange: (patch: Record<string, unknown>) => void;
    onCreateTable?: (table: SyncTableDraft, sync: SyncBlock) => void;
    onCreateTables?: (tables: SyncTableDraft[], sync: SyncBlock) => void;
    disabled?: boolean;
    saved?: boolean;
    onSave?: (() => unknown) | null;
}

export default function ConnectorSyncPanel({
    connector, tables = [], appId, onChange, onCreateTable, onCreateTables, disabled = false, saved = true,
    onSave = null,
}: ConnectorSyncPanelProps) {
    const { t } = useTranslation();
    const sync = connector.sync || null;
    const table = sync ? tables.find((tb) => tb.id === sync.tableId) : null;
    const actions = useSyncActions({ connector, appId, tables, t, onCreateTable, onCreateTables });

    // ── Not set up yet ──────────────────────────────────────────────
    if (!sync) {
        return <SyncSetup connector={connector} actions={actions} appId={appId} disabled={disabled} saved={saved} onSave={onSave} />;
    }

    // ── Already set up ──────────────────────────────────────────────
    return (
        <SyncSettings connector={connector} sync={sync} tableName={table?.name || table?.key || sync.tableId} actions={actions}
            appId={appId} disabled={disabled} saved={saved} onChange={onChange} />
    );
}
