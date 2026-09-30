/**
 * The ⋯ menu: what belongs to the TABLE rather than to a tab (the web's
 * TableMenu — Rename · Duplicate · Export · Technical name · Delete), plus
 * Import, which the web keeps in the rows toolbar and a phone has no room for.
 *
 * Duplicate copies the SHAPE — name, purpose, columns — never the rows; a
 * managed table (a cache, a mirror, a form's answers) has no shape of its own
 * to copy. The technical name is what a Datatable step refers to, so it is one
 * tap from the clipboard.
 */

import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { ActionMenu, Icon, IconButton, useToast, type ActionMenuItem } from '@/shared/ui';

import { DeleteTableSheet } from './DeleteTableSheet';
import { DetailsSheet } from './DetailsSheet';
import { ImportSheet } from './ImportSheet';
import { exportRows } from '../api/rows';
import { useDatatableSchema } from '../hooks/queries';
import { useCreateDatatable } from '../hooks/tableMutations';
import { draftOf, keyFromName } from '../model/columns';
import { pickCsv } from '../model/pickCsv';
import type { Datatable } from '../model/types';

type Open = { kind: 'details' } | { kind: 'delete' } | { kind: 'import'; file: { name: string; text: string } } | null;

export function TableMenu({ table, canEdit, canWrite }: { table: Datatable; canEdit: boolean; canWrite: boolean }) {
    const t = useTranslation();
    const router = useRouter();
    const { toast } = useToast();
    const [menu, setMenu] = useState(false);
    const [open, setOpen] = useState<Open>(null);
    const schema = useDatatableSchema(table.id);
    const create = useCreateDatatable();
    const fail = (err: unknown) => toast(describeError(err).message, 'error');

    const duplicate = () => {
        const name = t('datatables.duplicate_name', '{name} (copy)', { name: table.name });
        const fields = (schema.data?.fields ?? []).map((c) => ({ ...draftOf(c), id: undefined }));
        create.mutate(
            { scope: table.scopeKind === 'user' ? 'personal' : 'organisation', name, key: keyFromName(name), description: table.description, fields },
            { onSuccess: (copy) => copy && router.push(`/datatables/${copy.id}`), onError: fail },
        );
    };
    const importFile = async () => {
        const picked = await pickCsv();
        if (!picked) return;
        if ('tooLarge' in picked) return toast(t('mobile.datatables.file_too_large', 'That file is too large to import from a phone.'), 'error');
        setOpen({ kind: 'import', file: picked });
    };

    const items: ActionMenuItem[] = [
        ...(canEdit ? [{ id: 'rename', label: t('datatables.menu_rename', 'Rename table'), icon: 'Pencil' as const, onPress: () => setOpen({ kind: 'details' }) }] : []),
        ...(canEdit && !table.managedKind ? [{ id: 'duplicate', label: t('datatables.menu_duplicate', 'Duplicate'), icon: 'Copy' as const, accessibilityHint: t('datatables.menu_duplicate_hint', 'columns only, no rows'), onPress: duplicate }] : []),
        { id: 'export', label: t('datatables.export_csv_menu', 'Export (CSV)'), icon: 'Download', onPress: () => void exportRows(table.id, table.key).catch(fail) },
        ...(canWrite ? [{ id: 'import', label: t('datatables.import', 'Import'), icon: 'Upload' as const, onPress: () => void importFile().catch(fail) }] : []),
        {
            id: 'key',
            label: `${t('datatables.field_key', 'Technical name')}: ${table.key}`,
            icon: 'Key',
            onPress: () => void Clipboard.setStringAsync(table.key).then(() => toast(t('mobile.datatables.key_copied', 'Technical name copied'), 'success')),
        },
        ...(canEdit ? [{ id: 'delete', label: t('datatables.menu_delete', 'Delete this table…'), icon: 'Trash2' as const, destructive: true, onPress: () => setOpen({ kind: 'delete' }) }] : []),
    ];

    return (
        <>
            <IconButton icon={<Icon name="Ellipsis" size={20} />} accessibilityLabel={t('datatables.table_menu', 'More about this table')} onPress={() => setMenu(true)} testID="table-menu" />
            <ActionMenu visible={menu} onClose={() => setMenu(false)} title={table.name} items={items} testID="table-menu-sheet" />
            {open?.kind === 'details' ? <DetailsSheet table={table} onClose={() => setOpen(null)} /> : null}
            {open?.kind === 'delete' ? <DeleteTableSheet table={table} onClose={() => setOpen(null)} /> : null}
            {open?.kind === 'import' ? <ImportSheet tableId={table.id} columns={schema.data?.fields ?? []} file={open.file} onClose={() => setOpen(null)} /> : null}
        </>
    );
}
