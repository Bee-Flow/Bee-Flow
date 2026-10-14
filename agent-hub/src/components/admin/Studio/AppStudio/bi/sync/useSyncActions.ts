/**
 * The sync panel's server side: the last run's status, /inspect, a manual
 * refresh, and turning a mailbox or an accepted proposal into tables.
 */
import { useEffect, useState } from 'react';
import { mailboxSyncPlan, proposalSyncPlan } from './syncModel';
import type { SyncBlock, SyncPlan, SyncProposal, SyncTableDraft } from './syncModel';
import type { TranslateFn } from '../../../../../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../../../../../utils/helpers';
import { studioAppsApi } from '../../studioAppsApi';

/** The connector as the sync panel reads it. */
export interface SyncConnector {
    id: string;
    kind?: string;
    integrationId?: string;
    groupIntoThreads?: boolean;
    sync?: SyncBlock | null;
    [key: string]: unknown;
}

export interface SyncStatus {
    connectorId?: string;
    lastRunAt?: string | null;
    rowsWritten?: number;
    lastError?: string | null;
}

export interface RunResult {
    alreadyRunning?: boolean;
    inserted?: number;
    updated?: number;
    skipped?: number;
}

export interface SyncCallbacks {
    onCreateTable?: (table: SyncTableDraft, sync: SyncBlock) => void;
    onCreateTables?: (tables: SyncTableDraft[], sync: SyncBlock) => void;
}

interface SyncActionInputs extends SyncCallbacks {
    connector: SyncConnector;
    appId: string | null;
    tables: Array<{ key?: string }>;
    t: TranslateFn;
}

/** Hands a plan to whichever callback takes its shape. */
function applyPlan(plan: SyncPlan, { onCreateTable, onCreateTables }: SyncCallbacks) {
    if (plan.single) onCreateTable?.(plan.tables[0], plan.sync);
    else onCreateTables?.(plan.tables, plan.sync);
}

export function useSyncActions({ connector, appId, tables, t, onCreateTable, onCreateTables }: SyncActionInputs) {
    const sync = connector.sync || null;
    const [proposal, setProposal] = useState<SyncProposal | null>(null);   // /inspect result
    const [busy, setBusy] = useState<'inspect' | 'sync' | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [status, setStatus] = useState<SyncStatus | null>(null);       // last run state
    const [runResult, setRunResult] = useState<RunResult | null>(null);

    // Last run / next run / last error, so a silently failing schedule is visible
    // rather than something the owner discovers from stale data.
    useEffect(() => {
        if (!appId || !sync) return undefined;
        let alive = true;
        authFetch(`${API_BASE}/api/studio-apps/${encodeURIComponent(appId)}/data/connectors/sync-status`)
            .then((r: Response) => (r.ok ? r.json() : null))
            .then((b: { syncs?: SyncStatus[] } | null) => {
                if (!alive || !b) return;
                setStatus((b.syncs || []).find((s) => s.connectorId === connector.id) || null);
            })
            .catch(() => { /* status is advisory */ });
        return () => { alive = false; };
    }, [appId, connector.id, sync, runResult]);

    const call = async (path: string, label: 'inspect' | 'sync') => {
        setBusy(label);
        setError(null);
        try {
            const res = await authFetch(
                `${API_BASE}/api/studio-apps/${encodeURIComponent(appId as string)}/data/connectors/${encodeURIComponent(connector.id)}/${path}`,
                { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
            );
            let body = null;
            try { body = await res.json(); } catch { body = null; }
            if (!res.ok) {
                // A missing connection is the one failure with an obvious fix,
                // so it gets said in those terms rather than as a raw error.
                if (body?.code === 'connection_required') {
                    setError(t('studio_apps_bi.sync.err_connect', 'Connect {app} to your account first (Settings → Connections), then try again.', { app: body.provider || connector.integrationId || t('studio_apps_bi.sync.err_connect_that_app', 'that app') }));
                } else if (res.status === 404) {
                    setError(t('studio_apps_bi.sync.err_save_first', 'Save your changes first — this always runs the last saved version of the connector.'));
                } else {
                    setError(body?.error || t('studio_apps_bi.sync.err_failed', 'It did not work ({status}).', { status: res.status }));
                }
                return null;
            }
            return body;
        } catch (e) {
            setError((e as { message?: string }).message || t('studio_apps_bi.sync.err_unreachable', 'Could not reach the server.'));
            return null;
        } finally {
            setBusy(null);
        }
    };

    const inspect = async () => {
        const body = await call('inspect', 'inspect');
        if (body) setProposal(body);
    };

    /**
     * A mailbox needs no inspection: its columns are fixed, so the table can be
     * built here and now. That is not a shortcut — it breaks a deadlock. Every
     * other connector kind must be RUN once to discover its shape, which needs a
     * saved connector; but a mailbox connector cannot be saved without a table,
     * so "Set up a table" was disabled with "Save your changes first" while Save
     * refused for want of a table. There was no way out of that dialog.
     */
    const createMailboxTables = async () => {
        setBusy('inspect');
        setError(null);
        try {
            const catalog = await studioAppsApi.getCatalog();
            const templates = catalog?.mailboxTables;
            if (!templates?.message) throw new Error(t('studio_apps_bi.sync.err_no_mailbox_tables', 'This server does not describe the mailbox tables.'));
            applyPlan(mailboxSyncPlan(templates, connector.groupIntoThreads === true, tables), { onCreateTable, onCreateTables });
        } catch (e) {
            setError((e as { message?: string }).message || t('studio_apps_bi.sync.err_create_table', 'Could not create the table.'));
        } finally {
            setBusy(null);
        }
    };

    const refreshNow = async () => {
        const body = await call('sync', 'sync');
        if (body) setRunResult(body);
    };

    const accept = () => {
        if (!proposal) return;
        applyPlan(proposalSyncPlan(proposal), { onCreateTable, onCreateTables });
        setProposal(null);
    };

    return { proposal, setProposal, busy, error, status, runResult, inspect, createMailboxTables, refreshNow, accept };
}

export type SyncActions = ReturnType<typeof useSyncActions>;
