/**
 * Outlook categories need a column to land in.
 *
 * The mailbox sync writes each message's categories as comma-separated text in
 * `labels` (fetch.js normalizeGraph), and in thread mode the conversation gets
 * the categories of all its messages (mailboxConnector.js groupIntoThreads).
 * mapRowToColumns writes only columns the table has, so an app installed before
 * the column existed, or edited by hand since, dropped them without a word.
 *
 * Before an Outlook mailbox syncs, its message table and, in thread mode, its
 * conversation table get a text column `labels` when neither a column with that
 * key nor one reading that source path is there. Additive only, against the
 * model as it is stored now (expectedVersion), so an edit made in the editor
 * meanwhile is never overwritten; any failure leaves the model as it was and
 * the sync runs on. Gmail is left out: its labels are ids (INBOX, Label_123),
 * not names a person would want on screen.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

// Required, not imported: agent-hub's typecheck follows connectorSync.js into this file (see
// mailboxNewRecordHook.mts).
type Field = { id?: string; key?: string; sourcePath?: string; [k: string]: unknown };
type Table = { id?: string; fields?: Field[]; [k: string]: unknown };
type Model = { tables?: Table[]; [k: string]: unknown };
type Connector = {
    kind?: string; provider?: string; groupIntoThreads?: boolean;
    sync?: { tableId?: string; children?: Array<{ tableId?: string; level?: number }> } | null;
};
type Meta = { model?: Model; modelVersion?: number } | null;
type SaveResult = { ok?: boolean } | null | undefined;
type SaveOpts = { expectedVersion: number; additiveOnly: boolean };
type Log = { warn: (...a: unknown[]) => void; debug: (...a: unknown[]) => void };

export type LabelColumnDeps = {
    getDataModel?: (appId: string, ownerId: string) => Promise<Meta>;
    saveDataModel?: (appId: string, ownerId: string, model: Model, opts: SaveOpts) => Promise<SaveResult>;
};

export const LABELS_KEY = 'labels';

const log = nodeRequire('../telemetry/log') as Log;
const store = () => nodeRequire('../stores/studioAppDataStore') as Required<LabelColumnDeps>;

const hasLabels = (table: Table) => (table.fields || []).some((f) => f?.key === LABELS_KEY || f?.sourcePath === LABELS_KEY);

/** The tables of this connector whose rows carry `labels`: the messages, and in thread mode the conversations. */
export function labelTableIds(connector: Connector | null | undefined): string[] {
    const sync = connector?.sync;
    if (connector?.kind !== 'mailbox' || connector.provider !== 'outlook' || !sync?.tableId) return [];
    const ids = [sync.tableId];
    if (connector.groupIntoThreads) {
        const messages = (sync.children || []).find((c) => c?.level === 1);
        if (messages?.tableId) ids.push(messages.tableId);
    }
    return ids;
}

function missingIn(model: Model | null | undefined, ids: string[]): Set<string> {
    return new Set((model?.tables || [])
        .filter((t) => t?.id && ids.includes(t.id) && !hasLabels(t))
        .map((t) => t.id as string));
}

/**
 * The model with a `labels` column on every label table of this connector that
 * lacks one; the given model when nothing was missing or the save did not land.
 * Never throws.
 */
export async function ensureLabelColumns(
    app: { id: string; userId: string }, model: Model, connector: Connector, deps: LabelColumnDeps = {},
): Promise<Model> {
    const ids = labelTableIds(connector);
    if (!missingIn(model, ids).size) return model;
    const getDataModel = deps.getDataModel || ((a: string, o: string) => store().getDataModel(a, o));
    const saveDataModel = deps.saveDataModel || ((a: string, o: string, m: Model, opts: SaveOpts) => store().saveDataModel(a, o, m, opts));
    try {
        const meta = await getDataModel(app.id, app.userId);
        if (!meta?.model) return model;
        const todo = missingIn(meta.model, ids);
        // Added meanwhile (another replica, the editor): the stored model is the truth.
        if (!todo.size) return meta.model;
        const { newFieldId } = nodeRequire('../core/dataEngine/dataModel/ids') as { newFieldId: () => string };
        const next: Model = {
            ...meta.model,
            tables: (meta.model.tables || []).map((t) => (t?.id && todo.has(t.id)
                ? { ...t, fields: [...(t.fields || []), { id: newFieldId(), key: LABELS_KEY, name: 'Labels', type: 'text' }] }
                : t)),
        };
        const res = await saveDataModel(app.id, app.userId, next, { expectedVersion: meta.modelVersion || 0, additiveOnly: true });
        if (res?.ok) return next;
        log.debug(`[MailboxLabels] labels column not added to app ${app.id}; the next sync tries again`);
    } catch (e) {
        // A stage app's model changes only through a deploy (409 managed_part): expected, not news.
        const status = (e as { status?: number })?.status;
        (status === 409 ? log.debug : log.warn)(`[MailboxLabels] labels column for app ${app.id}: ${(e as Error)?.message}`);
    }
    return model;
}
