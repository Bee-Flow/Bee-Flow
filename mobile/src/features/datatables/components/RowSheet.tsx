/**
 * One row, added, changed or looked at — every column with the editor its type
 * calls for (FieldEditor), converted before it is sent (model/rowDraft).
 *
 * An edit sends only what changed, with the `updated_at` the row was read at;
 * a colleague's save in between comes back 409 `row_conflict`, the rows are
 * read again, and the sheet closes with a toast rather than overwriting their
 * change — as the web's RowBrowser does. Staying open would only conflict
 * again: every retry still carries the stale `updated_at`. A
 * person who may only read sees the same sheet with the editors off.
 */

import React, { useCallback, useState } from 'react';

import { ApiError } from '@/core/api/client';
import { useTranslation } from '@/core/i18n';
import { FormSheet, useConfirm } from '@/shared/patterns';
import { Button, Text, useToast } from '@/shared/ui';

import { FieldEditor } from './FieldEditor';
import { useAddRow, useDeleteRow, useUpdateRow } from '../hooks/rowMutations';
import { draftFromRow, editableColumns, valuesFromDraft, type DraftValue, type RowDraft } from '../model/rowDraft';
import type { Column, TableRow } from '../model/types';
import { cellErrorText } from '../model/words';

const isConflict = (err: unknown) => err instanceof ApiError && err.code === 'row_conflict';

export function RowSheet({
    tableId,
    row,
    columns,
    canWrite,
    onClose,
}: {
    tableId: string;
    /** The row, or null to add one. Mount per opening. */
    row: TableRow | null;
    columns: readonly Column[];
    canWrite: boolean;
    onClose: () => void;
}) {
    const t = useTranslation();
    const confirm = useConfirm();
    const { toast } = useToast();
    const [original] = useState<RowDraft | null>(() => (row ? draftFromRow(row, columns) : null));
    const [draft, setDraft] = useState<RowDraft>(() => draftFromRow(row, columns));
    const [errors, setErrors] = useState<Record<string, string>>({});
    const add = useAddRow(tableId);
    const update = useUpdateRow(tableId);
    const remove = useDeleteRow(tableId);
    const [failure, setFailure] = useState<unknown>(null);
    const onChange = useCallback((key: string, value: DraftValue) => setDraft((d) => ({ ...d, [key]: value })), []);

    const submit = () => {
        const check = valuesFromDraft(draft, columns, original);
        const worded = Object.fromEntries(Object.entries(check.errors).map(([k, code]) => [k, cellErrorText(t, code, String(draft[k] ?? ''))]));
        setErrors(worded);
        if (Object.keys(worded).length) return;
        if (row && !Object.keys(check.values).length) return onClose();
        setFailure(null);
        const done = { onSuccess: onClose, onError: setFailure };
        const onConflict = (err: unknown) => {
            if (!isConflict(err)) return setFailure(err);
            toast(t('datatables.err_row_conflict', 'Someone else changed this row while you had it open — the list has been refreshed.'), 'error');
            onClose();
        };
        if (row) update.mutate({ row, values: check.values }, { onSuccess: onClose, onError: onConflict });
        else add.mutate(check.values, done);
    };

    const deleteRow = async () => {
        if (!row) return;
        const ok = await confirm({
            title: t('datatables.row_delete_title', 'Delete this row?'),
            message: t('datatables.row_delete_body', 'It is gone for good, and any automation that reads it by id stops finding it.'),
            confirmLabel: t('datatables.row_delete_confirm', 'Delete the row'),
        });
        if (ok) remove.mutate(row.id, { onSuccess: onClose, onError: setFailure });
    };

    return (
        <FormSheet
            visible
            onClose={onClose}
            title={!row ? t('datatables.add_row', 'Add a row') : canWrite ? t('datatables.row_edit', 'Edit this row') : t('mobile.datatables.row_view', 'Row')}
            submitLabel={row ? t('datatables.row_save', 'Save this row') : t('datatables.add_row_submit', 'Add row')}
            onSubmit={submit}
            submitting={add.isPending || update.isPending}
            canSubmit={canWrite}
            error={failure}
        >
            {editableColumns(columns).map((column) => (
                <FieldEditor key={column.key} column={column} value={draft[column.key]} onChange={onChange} error={errors[column.key]} disabled={!canWrite} />
            ))}
            {row ? (
                <Text variant="caption" tone="tertiary">
                    {`${t('datatables.col_added', 'Added')}: ${String(row.created_at ?? '—').replace('T', ' ').slice(0, 16)}`}
                </Text>
            ) : null}
            {row && canWrite ? (
                <Button variant="danger" iconName="Trash2" label={t('datatables.row_delete', 'Delete this row')} loading={remove.isPending} onPress={() => void deleteRow()} />
            ) : null}
        </FormSheet>
    );
}
