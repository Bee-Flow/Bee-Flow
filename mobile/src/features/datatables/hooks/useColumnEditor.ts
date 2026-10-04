/**
 * Saving one column change against the whole list.
 *
 * PUT /schema takes the FULL column list and the version it was read at, so
 * every edit here is "the stored list, with this one change". What the web's
 * designer asks before a save, this asks too, in the same words:
 *
 *   - a removed or retyped column throws data away → confirmed with the row
 *     count and the automations that read it (the web's destructive dialog);
 *   - 409 `breaking_change` — the server saw an automation this screen's own
 *     usage list had not → confirmed again against THAT, then sent with
 *     `confirmBreaking`;
 *   - 409 `version_conflict` — a colleague saved first; their list is
 *     reloaded and the person makes the change again.
 */

import { useCallback } from 'react';

import { ApiError } from '@/core/api/client';
import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useConfirm } from '@/shared/patterns';

import { useSaveColumns } from './tableMutations';
import { destructiveChanges, draftOf } from '../model/columns';
import type { Column, ColumnDraft, Datatable, Schema, UsageRow } from '../model/types';

function destructiveMessage(t: TranslateFn, change: ReturnType<typeof destructiveChanges>, rows: number, readers: string[]): string {
    const parts: string[] = [];
    if (change.removed.length) {
        const keys = change.removed.join(', ');
        parts.push(
            rows === 1
                ? t('datatables.destructive_removed_one', 'Removing {keys} deletes its value in the 1 row.', { keys })
                : t('datatables.destructive_removed', 'Removing {keys} deletes its values in all {n} rows.', { keys, n: rows }),
        );
    }
    if (change.retyped.length) {
        const keys = change.retyped.map((r) => r.key).join(', ');
        parts.push(t('datatables.destructive_retyped', 'Changing the type of {keys} rewrites every existing value, and anything that does not fit the new type is lost.', { keys }));
    }
    if (readers.length) {
        const names = readers.join(', ');
        parts.push(
            readers.length === 1
                ? t('datatables.destructive_readers_one', '1 automation reads one of these columns and will stop working: {names}.', { names })
                : t('datatables.destructive_readers', '{n} automations read one of these columns and will stop working: {names}.', { n: readers.length, names }),
        );
    }
    return parts.join('\n\n');
}

/** The automations that name any of `keys` — or, not knowing the columns, every automation that reads. */
function readersOf(usage: readonly UsageRow[], keys: readonly string[]): string[] {
    const hit = usage.filter((u) => u.columns.some((c) => keys.includes(c)));
    return [...new Set(hit.map((u) => u.title || u.consumerId))];
}

const codeOf = (err: unknown) => (err instanceof ApiError ? err.code : undefined);

export function useColumnEditor(table: Datatable, schema: Schema | undefined, usage: readonly UsageRow[]) {
    const t = useTranslation();
    const confirm = useConfirm();
    const save = useSaveColumns(table.id);

    const ask = useCallback(
        (message: string) =>
            confirm({
                title: t('datatables.destructive_title', 'This throws away data'),
                message,
                confirmLabel: t('datatables.destructive_confirm', 'Save anyway'),
            }),
        [confirm, t],
    );

    /** Resolves false when the person backed out; throws a worded error when the server refused. */
    const apply = useCallback(
        async (next: ColumnDraft[]): Promise<boolean> => {
            if (!schema) return false;
            const change = destructiveChanges(schema.fields.map(draftOf), next);
            const touched = [...change.removed, ...change.retyped.map((r) => r.key)];
            if (change.any && !(await ask(destructiveMessage(t, change, table.rowCount, readersOf(usage, touched))))) return false;
            const body = { fields: next, expectedVersion: schema.modelVersion };
            try {
                await save.mutateAsync(body);
            } catch (err) {
                if (codeOf(err) === 'version_conflict') {
                    throw new Error(t('datatables.err_conflict', 'Someone else changed these columns while you were editing. Their version is now shown — please make your change again.'));
                }
                if (codeOf(err) !== 'breaking_change') throw err;
                if (!(await ask(t('datatables.err_breaking', 'An automation still uses a column you are removing. Check "used by" and confirm the change.')))) return false;
                await save.mutateAsync({ ...body, confirmBreaking: true });
            }
            return true;
        },
        [schema, ask, t, table.rowCount, usage, save],
    );

    const drafts = schema ? schema.fields.map(draftOf) : [];

    return {
        busy: save.isPending,
        /** A new column goes last; a changed one keeps its place (matched by id, then key). */
        upsert: (draft: ColumnDraft) => {
            const at = drafts.findIndex((d) => (draft.id && d.id === draft.id) || d.key === draft.key);
            const next = at < 0 ? [...drafts, draft] : drafts.map((d, i) => (i === at ? draft : d));
            return apply(next);
        },
        remove: (column: Column) => apply(drafts.filter((d) => d.key !== column.key)),
    };
}
