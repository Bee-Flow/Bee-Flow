/**
 * The Columns tab — the web's ColumnDesigner for a phone: every column with its
 * kind, the columns the platform fills in marked as locked, and a sheet per
 * column to add, change or remove one. Each change is saved on its own (see
 * useColumnEditor for what is asked first).
 */

import React, { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Badge, Banner, Button, DataList, ErrorState, LoadingState, Text, useToast, type DataColumn } from '@/shared/ui';

import { ColumnSheet } from './ColumnSheet';
import { TableLede } from './TableLede';
import { useDatatableSchema, useDatatableUsage } from '../hooks/queries';
import { useColumnEditor } from '../hooks/useColumnEditor';
import { COLUMN_TYPES, columnLabel, isManagedColumn, isSchemaLocked, isSourceMirror } from '../model/columns';
import type { Column, Datatable } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        content: { padding: theme.spacing.lg, gap: theme.spacing.md, paddingBottom: theme.spacing.xxxl },
        name: { gap: 2 },
    });

type Editing = { column: Column | null } | null;

function lockedNotice(t: ReturnType<typeof useTranslation>, table: Datatable, canEdit: boolean): string | null {
    if (table.managedKind === 'form_answers') {
        return t('datatables.frm_columns_locked', 'These columns are the questions on the form. Add, rename or remove questions on the form — the table follows. A column whose question was removed stays here, marked “no longer on the form”, and can be removed from this tab.');
    }
    if (isSourceMirror(table)) {
        return t('datatables.src_columns_locked', 'These columns come from {source} and cannot be added to, removed, renamed or retyped here. Change them in {source} — the next refresh brings them here.', {
            source: t('mobile.datatables.the_source', 'the source'),
        });
    }
    if (!canEdit) return t('datatables.columns_readonly', 'You can see the columns but not change them. The table’s owner, or an administrator, can.');
    if (table.managedKind) return t('datatables.columns_managed', 'The locked columns are filled in automatically and cannot be removed, renamed or retyped. Columns of your own can be added alongside them.');
    return null;
}

export function ColumnsTab({ table, canEdit }: { table: Datatable; canEdit: boolean }) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const { toast } = useToast();
    const schema = useDatatableSchema(table.id);
    const usage = useDatatableUsage(table.id);
    const editor = useColumnEditor(table, schema.data, usage.data ?? []);
    const [editing, setEditing] = useState<Editing>(null);
    const locked = isSchemaLocked(table.managedKind);
    const editable = useCallback(
        (c: Column) => canEdit && !isManagedColumn(table.managedKind, c.key),
        [canEdit, table.managedKind],
    );

    const columns: DataColumn<Column>[] = [
        {
            id: 'name',
            label: t('datatables.col_head_column', 'Column'),
            flex: 2,
            render: (c) => (
                <View style={styles.name}>
                    <Text variant="caption" weight="medium" numberOfLines={1}>{columnLabel(c)}</Text>
                    <Text variant="label" tone="tertiary" numberOfLines={1}>{c.key}</Text>
                </View>
            ),
        },
        {
            id: 'kind',
            label: t('datatables.col_head_kind', 'Kind'),
            flex: 1.4,
            render: (c) => {
                const entry = COLUMN_TYPES.find((x) => x.type === c.type);
                return entry ? t(entry.key, entry.fallback) : c.type;
            },
        },
        {
            id: 'flags',
            label: '',
            width: 76,
            align: 'right',
            render: (c) =>
                isManagedColumn(table.managedKind, c.key) ? (
                    <Badge label={t('mobile.datatables.locked', 'Locked')} icon="Lock" />
                ) : c.required ? (
                    <Badge label={t('mobile.datatables.required', 'Required')} tone="info" />
                ) : null,
        },
    ];

    if (schema.isLoading) return <LoadingState />;
    if (schema.isError || !schema.data) return <ErrorState error={schema.error} onRetry={() => void schema.refetch()} />;
    const fields = schema.data.fields;
    const notice = lockedNotice(t, table, canEdit);
    const save = (run: () => Promise<boolean>) =>
        run().then((done) => {
            if (!done) return;
            setEditing(null);
            toast(t('datatables.columns_saved', 'Columns saved.'), 'success');
        });

    return (
        <ScrollView contentContainerStyle={styles.content}>
            <TableLede table={table} columnCount={fields.length} />
            {notice ? <Banner tone="info" icon="Lock">{notice}</Banner> : null}
            <DataList
                virtualized={false}
                columns={columns}
                rows={fields}
                onRowPress={(c) => (editable(c) ? setEditing({ column: c }) : undefined)}
                rowLabel={(c) => columnLabel(c)}
                empty={
                    <Text variant="caption" tone="secondary" style={styles.content}>
                        {t('datatables.columns_empty', 'No columns yet. Every table already has id, created_at, updated_at and created_by — add the ones your automation needs on top.')}
                    </Text>
                }
                testID="columns"
            />
            {canEdit && !locked ? (
                <Button variant="secondary" iconName="Plus" label={t('datatables.column_add', 'Add a column')} onPress={() => setEditing({ column: null })} testID="add-column" />
            ) : null}
            {editing ? (
                <ColumnSheet
                    column={editing.column}
                    takenKeys={fields.filter((f) => f.key !== editing.column?.key).map((f) => f.key)}
                    busy={editor.busy}
                    onClose={() => setEditing(null)}
                    onSave={(draft) => save(() => editor.upsert(draft))}
                    onDelete={editing.column ? () => void save(() => editor.remove(editing.column as Column)).catch((e: unknown) => toast(describeError(e).message, 'error')) : undefined}
                />
            ) : null}
        </ScrollView>
    );
}
