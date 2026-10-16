/**
 * "Keep this in a table" — the pure parts: the sync block's shape, the tables
 * a mailbox or an /inspect proposal turns into, the refresh choices, and the
 * honest copy for each kind of incremental loading.
 */
import type { TranslateFn } from '../../../../../../hooks/useTranslation';

export const INPUT = 'w-full rounded-md px-2 py-1.5 text-sm bg-[var(--bg-tertiary)] border border-[var(--border-default)] text-[var(--text-primary)]';
export const LABEL = 'text-xs font-medium text-[var(--text-secondary)]';

/** One field of a table template or a proposed table. */
export interface SyncField {
    key: string;
    id?: string;
    [key: string]: unknown;
}

/** A table as the sync creates it. */
export interface SyncTableDraft {
    id: string;
    key: string;
    name: string;
    icon?: string | null;
    fields: SyncField[];
    access?: { default: string };
    [key: string]: unknown;
}

export interface Incremental {
    field?: string;
    param?: string;
    format?: string;
    mode?: string;
}

/** A connector's `sync` block (server/appStudio/dataModel.js). */
export interface SyncBlock {
    /** Absent while the table it fills is still to be made. */
    tableId?: string;
    mode?: string;
    keyField?: string;
    incremental?: Incremental | null;
    schedule?: { everyMinutes?: number; cron?: string; tz?: string };
    refreshOnView?: boolean;
    retentionDays?: number;
    children?: Array<{ tableId?: string; [key: string]: unknown } | null>;
    [key: string]: unknown;
}

/** One table of a chain's related set, as /inspect proposes it. */
export interface ProposedSetTable {
    table: SyncTableDraft;
    rowCount?: number;
    identity?: string | null;
    keyField?: string;
    defaultMode?: string;
    level?: number;
    parentLevel?: number;
    relationField?: string;
    expandFrom?: string | null;
}

/** What POST /inspect answers. */
export interface SyncProposal {
    rowCount?: number;
    suggestedTable: SyncTableDraft;
    identity?: string | null;
    keyField?: string;
    defaultMode?: string;
    incremental?: Incremental | null;
    tableSet?: { tables?: ProposedSetTable[] } | null;
}

/** `tbl_`/`fld_` ids, mirroring the server's id shape. */
// nosemgrep: ajinabraham.njsscan.crypto.crypto_node.node_insecure_random_generator -- a local schema id for a new table, not a secret or a token
function tableId() { return `tbl_${Math.random().toString(36).slice(2, 8)}`; }
// nosemgrep: ajinabraham.njsscan.crypto.crypto_node.node_insecure_random_generator -- a local schema id for a new field, not a secret or a token
function fieldId() { return `fld_${Math.random().toString(36).slice(2, 8)}`; }

interface TableTemplate {
    name: string;
    icon?: string | null;
    fields?: SyncField[];
}

/** A catalog table TEMPLATE (keys + types, no ids) → a real table. */
export function materialiseTable(template: TableTemplate, preferredKey: string, existing: Array<{ key?: string }> = []): SyncTableDraft {
    const taken = new Set((existing || []).map((t) => t.key));
    let key = preferredKey;
    let n = 2;
    while (taken.has(key)) key = `${preferredKey}_${n++}`;
    return {
        id: tableId(),
        key,
        name: template.name,
        icon: template.icon || null,
        fields: (template.fields || []).map((f) => ({ ...f, id: fieldId() })),
        access: { default: 'app' },
    };
}

/** What a sync creates: the tables, and the sync block that fills them. */
export type SyncPlan = { tables: SyncTableDraft[]; sync: SyncBlock; single: boolean };

/**
 * The tables a mailbox fills — no inspection needed, its columns are fixed:
 * one messages table, or (grouped into threads) a conversations table with
 * its messages linked underneath.
 */
export function mailboxSyncPlan(templates: { message: TableTemplate; thread: TableTemplate }, threaded: boolean, existing: Array<{ key?: string }>): SyncPlan {
    const built = (template: TableTemplate, key: string) => materialiseTable(template, key, existing);
    if (threaded) {
        const threads = built(templates.thread, 'tickets');
        const messages = built(templates.message, 'messages');
        return {
            single: false,
            tables: [threads, messages],
            sync: {
                tableId: threads.id,
                mode: 'upsert',
                keyField: 'thread_key',
                incremental: { field: 'last_message_at', format: 'iso' },
                schedule: { everyMinutes: 2 },
                refreshOnView: true,
                retentionDays: 90,
                children: [{
                    tableId: messages.id, level: 1, parentLevel: 0,
                    relationField: 'ticket', keyField: 'provider_message_id', mode: 'upsert',
                }],
            },
        };
    }
    const messages = built(templates.message, 'messages');
    return {
        single: true,
        tables: [messages],
        sync: {
            tableId: messages.id,
            mode: 'upsert',
            keyField: 'provider_message_id',
            incremental: { field: 'received_at', format: 'iso' },
            schedule: { everyMinutes: 2 },
            refreshOnView: true,
            retentionDays: 90,
        },
    };
}

/** The tables and sync block an accepted /inspect proposal turns into. */
export function proposalSyncPlan(proposal: SyncProposal): SyncPlan {
    const inc = proposal.incremental || {};
    const incrementalBlock = inc.mode && inc.mode !== 'none'
        ? { incremental: { field: inc.field, ...(inc.param ? { param: inc.param } : {}), format: inc.format || 'iso' } }
        : {};

    // A chain that expanded proposes RELATED tables — one per grain, joined
    // by a relation column — rather than one wide table that would repeat
    // every parent field once per child.
    const set = proposal.tableSet?.tables;
    if (set && set.length > 1) {
        const [parent, ...children] = set;
        return {
            single: false,
            tables: set.map((t) => t.table),
            sync: {
                tableId: parent.table.id,
                mode: parent.defaultMode,
                ...(parent.keyField ? { keyField: parent.keyField } : {}),
                ...incrementalBlock,
                schedule: { everyMinutes: 60 },
                refreshOnView: true,
                children: children.map((c) => ({
                    tableId: c.table.id,
                    level: c.level,
                    parentLevel: c.parentLevel ?? 0,
                    relationField: c.relationField,
                    mode: c.defaultMode,
                    ...(c.keyField ? { keyField: c.keyField } : {}),
                })),
            },
        };
    }
    return {
        single: true,
        tables: [proposal.suggestedTable],
        sync: {
            tableId: proposal.suggestedTable.id,
            mode: proposal.defaultMode,
            ...(proposal.keyField ? { keyField: proposal.keyField } : {}),
            ...incrementalBlock,
            schedule: { everyMinutes: 60 },
            refreshOnView: true,
        },
    };
}

const intervals = (t: TranslateFn) => [
    { minutes: 15, label: t('studio_apps_bi.sync.every_15_min', 'Every 15 minutes') },
    { minutes: 60, label: t('studio_apps_bi.sync.every_hour', 'Every hour') },
    { minutes: 360, label: t('studio_apps_bi.sync.every_6_hours', 'Every 6 hours') },
    { minutes: 1440, label: t('studio_apps_bi.sync.once_a_day', 'Once a day') },
];

/**
 * A mailbox may poll far more often than anything else — an inbox that notices
 * a customer's mail a quarter of an hour late is not an inbox. The floor is
 * enforced server-side per connector kind (dataModel.MIN_SYNC_MINUTES_BY_KIND);
 * these are just the choices we offer.
 */
const mailboxIntervals = (t: TranslateFn) => [
    { minutes: 2, label: t('studio_apps_bi.sync.every_2_min', 'Every 2 minutes') },
    { minutes: 5, label: t('studio_apps_bi.sync.every_5_min', 'Every 5 minutes') },
    ...intervals(t),
];

export function intervalsFor(kind: string | undefined, t: TranslateFn) {
    return kind === 'mailbox' ? mailboxIntervals(t) : intervals(t);
}

export interface IncrementalCopy {
    title: string;
    body: string;
    field: string | undefined;
}

export function incrementalModeCopy(mode: string, field: string | undefined, param: string | undefined, t: TranslateFn): IncrementalCopy {
    if (mode === 'request') {
        return {
            title: t('studio_apps_bi.sync.incr_request_title', 'Only fetch what changed'),
            body: t('studio_apps_bi.sync.incr_request_body', 'This action can filter on “{param}”, so each refresh asks for records changed since the last one. Fewest calls, least data.', { param }),
            field,
        };
    }
    return {
        title: t('studio_apps_bi.sync.incr_client_title', 'Only save what changed'),
        body: t('studio_apps_bi.sync.incr_client_body', 'This action can’t filter by date, so every refresh still fetches the full list — but only rows with a newer “{field}” are written. It keeps the table quiet; it does not reduce API calls.', { field }),
        field,
    };
}

/**
 * A mailbox filters by date at the provider, so the generic "this action can't
 * filter by date" copy above is simply wrong for it — it would tell someone
 * their inbox re-downloads itself every two minutes when it does not.
 */
const mailboxIncrementalCopy = (field: string | undefined, t: TranslateFn): IncrementalCopy => ({
    title: t('studio_apps_bi.sync.incr_mail_title', 'Only fetch new mail'),
    body: t('studio_apps_bi.sync.incr_mail_body', 'Each refresh asks the mail provider for messages received since the last one, with a short overlap so nothing slips through. Only rows with a newer “{field}” are written.', { field }),
    field,
});

export function incrementalCopy(connectorKind: string | undefined, incremental: Incremental, t: TranslateFn): IncrementalCopy {
    if (connectorKind === 'mailbox') return mailboxIncrementalCopy(incremental.field, t);
    return incrementalModeCopy(incremental.param ? 'request' : 'client', incremental.field, incremental.param, t);
}

export function relative(iso: string | null | undefined, t: TranslateFn): string {
    if (!iso) return t('studio_apps_bi.sync.never', 'never');
    const diff = Date.now() - new Date(iso).getTime();
    if (Number.isNaN(diff)) return t('studio_apps_bi.sync.never', 'never');
    const mins = Math.round(diff / 60000);
    if (mins < 1) return t('studio_apps_bi.sync.just_now', 'just now');
    if (mins < 60) return t('studio_apps_bi.sync.min_ago', '{n} min ago', { n: mins });
    const hours = Math.round(mins / 60);
    if (hours < 24) return t('studio_apps_bi.sync.hours_ago', '{n} h ago', { n: hours });
    return t('studio_apps_bi.sync.days_ago', '{n} d ago', { n: Math.round(hours / 24) });
}
