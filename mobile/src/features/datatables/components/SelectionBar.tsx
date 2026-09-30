/**
 * The bar that replaces the toolbar while rows are being ticked: how many,
 * delete them in one go, or stop. The server deletes at most 200 at a time
 * and answers how many really went, which is what the toast says.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useConfirm } from '@/shared/patterns';
import { Button, Text, useToast } from '@/shared/ui';

import { BULK_DELETE_MAX } from '../api/rows';
import { useDeleteRows } from '../hooks/rowMutations';

const styles = StyleSheet.create({
    root: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 48 },
    count: { flex: 1 },
});

export function SelectionBar({ tableId, selected, onDone }: { tableId: string; selected: ReadonlySet<string>; onDone: () => void }) {
    const t = useTranslation();
    const confirm = useConfirm();
    const { toast } = useToast();
    const remove = useDeleteRows(tableId);
    const n = selected.size;
    const tooMany = n > BULK_DELETE_MAX;

    const run = async () => {
        const ok = await confirm({
            title: t('datatables.bulk_delete_title', 'Delete {n} rows?', { n }),
            message: t('datatables.bulk_delete_body', 'They are gone for good, in one go, and any automation that reads them by id stops finding them.'),
            confirmLabel: t('datatables.bulk_delete_confirm', 'Delete them'),
        });
        if (!ok) return;
        remove.mutate([...selected], {
            onSuccess: ({ deleted }) => {
                if (deleted < n) toast(t('datatables.bulk_partial', 'Deleted {n} of {asked} rows — the rest were already gone.', { n: deleted, asked: n }), 'neutral');
                onDone();
            },
            onError: () => toast(t('datatables.err_bulk_delete', 'Could not delete those rows'), 'error'),
        });
    };

    return (
        <View style={styles.root}>
            <Text variant="caption" weight="semibold" style={styles.count}>
                {tooMany
                    ? t('datatables.bulk_too_many', 'You can delete at most {limit} rows at a time.', { limit: BULK_DELETE_MAX })
                    : n === 1
                      ? t('datatables.selected_one', '1 row selected')
                      : t('datatables.selected_n', '{n} rows selected', { n })}
            </Text>
            <Button
                size="sm"
                variant="danger"
                iconName="Trash2"
                label={t('datatables.selection_delete', 'Delete selected')}
                disabled={!n || tooMany}
                loading={remove.isPending}
                onPress={() => void run()}
                testID="selection-delete"
            />
            <Button size="sm" variant="ghost" label={t('datatables.selection_clear', 'Clear selection')} onPress={onDone} />
        </View>
    );
}
