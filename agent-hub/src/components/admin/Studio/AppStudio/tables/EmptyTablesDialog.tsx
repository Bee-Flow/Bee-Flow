import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { emptyAppTables } from './recordsApi';
import type { EmptyTablesResult } from './recordsApi';
import type { ModelTable } from './tablesManagerModel';
import Modal from '@/components/shared/Modal';
import useTranslation from '@/hooks/useTranslation';
import { errorBodyRecord, errorCode, messageOf } from '@/utils/caughtError';

/**
 * "Start clean": delete every row of the chosen tables (all of them when
 * `tableIds` is null), keep the tables. The owner confirms by typing the app's
 * name. A table that another table still points at comes back as 409
 * `referenced_by`; the dialog names the pair and offers to include the pointing
 * tables and retry.
 */

export interface EmptyTablesDialogProps {
    open: boolean;
    appId: string;
    appName: string;
    /** Saved tables of the app (the ones that have storage). */
    tables: ModelTable[];
    /** The tables to empty; null = all of them. */
    tableIds: string[] | null;
    onClose: () => void;
    onDone: (result: EmptyTablesResult) => void;
}

interface Blocker { tableId: string; key: string; referencedBy: string[] }

const nameOf = (tbl: ModelTable) => tbl.name || tbl.key;

function blockersOf(err: unknown): Blocker[] | null {
    const code = errorCode(err);
    if (code !== 'referenced_by' && code !== 'relation_cycle') return null;
    const list = errorBodyRecord(err)?.tables;
    return Array.isArray(list) ? (list as Blocker[]) : [];
}

function rowCountOf(tbl: ModelTable): number | null {
    const n = tbl.rowCount;
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function ChosenList({ chosen }: { chosen: ModelTable[] }) {
    const { t } = useTranslation();
    return (
        <ul className="max-h-40 overflow-y-auto rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-2" data-testid="empty-tables-list">
            {chosen.map((tbl) => {
                const n = rowCountOf(tbl);
                return (
                    <li key={tbl.id} className="flex justify-between gap-2 py-0.5 text-[var(--text-primary)]">
                        <span className="truncate">{nameOf(tbl)}</span>
                        {n === null ? null : <span className="shrink-0 text-[var(--text-tertiary)]">{t('studio_apps_tables.empty.row_count', '{n} rows', { n })}</span>}
                    </li>
                );
            })}
        </ul>
    );
}

function BlockerNotice({ blockers, busy, onInclude }: { blockers: Blocker[]; busy: boolean; onInclude: () => void }) {
    const { t } = useTranslation();
    return (
        <div role="alert" className="rounded-lg border border-[var(--error)] p-3 text-[var(--text-primary)]">
            <ul>
                {blockers.map((b) => (
                    <li key={b.tableId}>
                        {b.referencedBy.map((child) => t('studio_apps_tables.empty.still_points', 'Empty {child} too — it still points at {parent}', { child, parent: b.key })).join('; ')}
                    </li>
                ))}
            </ul>
            <button type="button" onClick={onInclude} disabled={busy}
                className="mt-2 rounded-lg bg-[var(--accent-primary)] px-3 py-1.5 text-xs font-medium text-[var(--accent-primary-fg)] disabled:opacity-50">
                {t('studio_apps_tables.empty.include', 'Include these tables')}
            </button>
        </div>
    );
}

function DialogFooter({ busy, canConfirm, onCancel, onConfirm }: { busy: boolean; canConfirm: boolean; onCancel: () => void; onConfirm: () => void }) {
    const { t } = useTranslation();
    return (
        <>
            <button type="button" onClick={onCancel} disabled={busy}
                className="rounded-lg bg-white/5 px-4 py-2 text-sm text-[var(--text-primary)] hover:bg-white/10 disabled:opacity-50">
                {t('studio_apps_tables.empty.cancel', 'Cancel')}
            </button>
            <button type="button" onClick={onConfirm} disabled={busy || !canConfirm}
                className="inline-flex items-center gap-2 rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50">
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
                {t('studio_apps_tables.empty.confirm', 'Delete all rows')}
            </button>
        </>
    );
}

export default function EmptyTablesDialog({ open, appId, appName, tables, tableIds, onClose, onDone }: EmptyTablesDialogProps) {
    const { t } = useTranslation();
    const [typed, setTyped] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [blockers, setBlockers] = useState<Blocker[] | null>(null);
    // Tables added through "Include these tables"; the chosen set grows, never shrinks.
    const [extra, setExtra] = useState<string[]>([]);

    const chosenIds = tableIds === null && extra.length === 0 ? null : [...(tableIds || []), ...extra.filter((id) => !(tableIds || []).includes(id))];
    const chosen = chosenIds === null ? tables : tables.filter((tbl) => chosenIds.includes(tbl.id));
    const nameMatches = appName.trim() !== '' && typed.trim().toLowerCase() === appName.trim().toLowerCase();
    const keyToId = new Map(tables.map((tbl) => [tbl.key, tbl.id]));

    const run = async (ids: string[] | null) => {
        setBusy(true);
        setError(null);
        try {
            const result = await emptyAppTables(appId, ids ?? undefined);
            setBlockers(null);
            setExtra([]);
            setTyped('');
            onDone(result);
        } catch (err) {
            const found = blockersOf(err);
            if (found) setBlockers(found);
            else setError(messageOf(err, t('studio_apps_tables.empty.failed', 'The tables could not be emptied.')));
        } finally {
            setBusy(false);
        }
    };

    const includeBlockers = () => {
        const ids = (blockers || []).flatMap((b) => b.referencedBy.map((k) => keyToId.get(k))).filter((id): id is string => !!id);
        const widened = Array.from(new Set([...(chosenIds || tables.map((tbl) => tbl.id)), ...ids]));
        setExtra(widened);
        setBlockers(null);
        void run(widened);
    };

    const close = () => {
        if (busy) return;
        setTyped('');
        setError(null);
        setBlockers(null);
        setExtra([]);
        onClose();
    };

    return (
        <Modal
            open={open}
            onClose={close}
            title={chosenIds === null
                ? t('studio_apps_tables.empty.title_all', 'Empty all tables?')
                : t('studio_apps_tables.empty.title_some', 'Empty the selected tables?')}
            size="md"
            disableBackdropClose={busy}
            disableEscapeClose={busy}
            footer={<DialogFooter busy={busy} canConfirm={nameMatches && !blockers} onCancel={close} onConfirm={() => void run(chosenIds)} />}
        >
            <div className="flex flex-col gap-3 text-sm text-[var(--text-secondary)]">
                <p>{t('studio_apps_tables.empty.what', 'All rows in the tables below are deleted for good, including their files. The tables, columns, screens and automations stay.')}</p>
                <p>{t('studio_apps_tables.empty.connectors', 'Connected mailboxes and connectors fill the tables again from their look-back window on their next sync, without running “new mail” automations for that old mail.')}</p>
                <ChosenList chosen={chosen} />
                {blockers ? <BlockerNotice blockers={blockers} busy={busy} onInclude={includeBlockers} /> : null}
                {error ? <p role="alert" className="text-[var(--error)]">{error}</p> : null}
                <label className="flex flex-col gap-1 text-xs">
                    {t('studio_apps_tables.empty.type_name', 'Type the app’s name ({name}) to confirm', { name: appName })}
                    <input
                        type="text"
                        value={typed}
                        onChange={(e) => setTyped(e.target.value)}
                        disabled={busy}
                        autoComplete="off"
                        className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)]"
                    />
                </label>
            </div>
        </Modal>
    );
}
