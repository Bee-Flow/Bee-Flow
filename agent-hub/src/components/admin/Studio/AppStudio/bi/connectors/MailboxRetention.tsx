import { useState } from 'react';
import { INPUT, LABEL } from './connectorModel';
import type { Connector } from './connectorModel';
import type { SyncBlock } from '../sync/syncModel';
import type { ModelTable } from '../../tables/tablesManagerModel';
import useTranslation from '@/hooks/useTranslation';

/**
 * The longest the server keeps mail for (MAX_MAILBOX_RETENTION_DAYS). A mailbox always has a
 * retention: connectorValidate refuses one without, because an unbounded copy of customer mail
 * is not defensible — so there is no "do not delete" choice here.
 */
const MAX_RETENTION_DAYS = 730;

/** A whole number of days the server accepts, or null. */
export function parseRetentionDays(raw: string): number | null {
    if (!/^\d+$/.test(raw.trim())) return null;
    const n = Number(raw);
    return n >= 1 && n <= MAX_RETENTION_DAYS ? n : null;
}

/**
 * The date and datetime column keys of the sync's MAIN table: sync.retentionField is read on that
 * table only (retentionPlan.js); child tables follow it by cascade, so offering their columns would
 * only produce a save the server refuses.
 */
function dateColumnKeys(sync: SyncBlock, tables: ModelTable[]): string[] {
    const main = tables.find((table) => table.id === sync.tableId);
    const keys: string[] = [];
    for (const column of main?.fields || []) {
        const isDate = column.type === 'date' || column.type === 'datetime';
        if (isDate && column.key && !keys.includes(column.key)) keys.push(column.key);
    }
    return keys;
}

interface MailboxRetentionProps {
    connector: Connector;
    tables: ModelTable[];
    patch: (p: Record<string, unknown>) => void;
    disabled?: boolean;
}

/** What the date column defaults to, what is removed (the mail copy only), and what a later label does. */
function RetentionHints({ connector, days, showColumnHint }: { connector: Connector; days: number | null; showColumnHint: boolean }) {
    const { t } = useTranslation();
    const threaded = Boolean(connector.groupIntoThreads);
    const gmail = connector.provider === 'gmail';
    return (
        <>
            {showColumnHint ? (
                <p className="text-xs text-[var(--text-tertiary)]">
                    {t('studio_apps_bi.connectors.retention_field_hint_flat', 'Automatic uses the date the message was received (received_at).')}
                </p>
            ) : null}
            {days !== null ? (
                <p className="text-xs text-[var(--text-tertiary)]">
                    {gmail
                        ? t('studio_apps_bi.connectors.retention_removed_gmail', 'Mail older than {days} days is removed from the app; it stays in Gmail.', { days })
                        : t('studio_apps_bi.connectors.retention_removed_outlook', 'Mail older than {days} days is removed from the app; it stays in Outlook.', { days })}
                </p>
            ) : null}
            <p className="text-xs text-[var(--text-tertiary)]">
                {threaded
                    ? t('studio_apps_bi.connectors.retention_records_stay_thread', 'Conversations and the app’s own records stay.')
                    : t('studio_apps_bi.connectors.retention_records_stay_flat', 'The app’s own records stay.')}
                {' '}
                {gmail
                    ? t('studio_apps_bi.connectors.retention_hint_gmail', 'With “Only fetch new mail” on, Gmail reads only newly arriving mail.')
                    : t('studio_apps_bi.connectors.retention_hint_outlook', 'Outlook mail you label later is picked up on the next sync.')}
            </p>
        </>
    );
}

/** How long synced mail is kept, and which date column that is measured from. */
export default function MailboxRetention({ connector, tables, patch, disabled }: MailboxRetentionProps) {
    const { t } = useTranslation();
    const sync = connector.sync;
    const days = sync?.retentionDays;
    const [draft, setDraft] = useState(typeof days === 'number' ? String(days) : '');
    if (!sync) return null;

    const invalid = draft !== '' && parseRetentionDays(draft) === null;
    // In thread mode the main table holds conversations (app records, never purged): the mail is dated on received_at.
    const columns = connector.groupIntoThreads ? [] : dateColumnKeys(sync, tables);

    const write = (changes: Record<string, unknown>) => {
        const next: SyncBlock = { ...sync };
        for (const [k, v] of Object.entries(changes)) {
            if (v === undefined || v === '') delete next[k]; else next[k] = v;
        }
        patch({ sync: next });
    };
    const onDays = (raw: string) => {
        setDraft(raw);
        const n = parseRetentionDays(raw);
        if (n !== null) write({ retentionDays: n });
    };

    return (
        <div className="flex flex-col gap-2">
            <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1">
                    <span className={LABEL}>{t('studio_apps_bi.connectors.retention_days', 'Keep mail for (days)')}</span>
                    <input
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={MAX_RETENTION_DAYS}
                        step={1}
                        className={INPUT}
                        value={draft}
                        onChange={(e) => onDays(e.target.value)}
                        disabled={disabled}
                        aria-invalid={invalid}
                        aria-label={t('studio_apps_bi.connectors.retention_days', 'Keep mail for (days)')}
                    />
                </label>
                {columns.length > 1 ? (
                    <label className="flex flex-col gap-1">
                        <span className={LABEL}>{t('studio_apps_bi.connectors.retention_field', 'Date column')}</span>
                        <select
                            className={INPUT}
                            value={typeof sync.retentionField === 'string' ? sync.retentionField : ''}
                            onChange={(e) => write({ retentionField: e.target.value })}
                            disabled={disabled}
                            aria-label={t('studio_apps_bi.connectors.retention_field', 'Date column')}
                        >
                            <option value="">{t('studio_apps_bi.connectors.retention_field_auto', 'Message date (automatic)')}</option>
                            {columns.map((key) => <option key={key} value={key}>{key}</option>)}
                        </select>
                    </label>
                ) : null}
            </div>
            {invalid ? (
                <p role="alert" className="text-xs text-[var(--warning)]">
                    {t('studio_apps_bi.connectors.retention_invalid', 'Enter a whole number of days from 1 to {max}.', { max: MAX_RETENTION_DAYS })}
                </p>
            ) : null}
            <RetentionHints connector={connector} days={parseRetentionDays(draft)} showColumnHint={columns.length > 1} />
        </div>
    );
}
