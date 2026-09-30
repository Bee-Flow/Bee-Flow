/**
 * One table (the web's DatatableDetail): its columns, its rows, how long they
 * are kept, who it is shared with, and — the tab that earns its place — what
 * depends on it. "Used by" is last because it is where the destructive
 * actions send you. A linked table (a mirror) has no Retention tab: the
 * server refuses it a window, and a tab that can only say so should not exist.
 *
 * What the session may do is the SERVER's answer carried on the table
 * (`grade`), never guessed: the owner (with `manage_datatables` on an
 * organisation table) changes the table itself, an editor changes rows, a
 * viewer reads. A linked table whose source cannot be written back is read
 * here too.
 *
 * Not here, and open on the web: a mirror's Source tab, a form's answers
 * dashboard (the form's own Answers tab has it), and Check & repair.
 */

import React, { useState } from 'react';

import { useHasPermission } from '@/core/access';
import { useTranslation } from '@/core/i18n';
import { QueryScreen } from '@/shared/patterns';
import { ObjectHeader, type TabBarItem } from '@/shared/ui';

import { ColumnsTab } from '../components/ColumnsTab';
import { RetentionTab } from '../components/RetentionTab';
import { RowsTab } from '../components/RowsTab';
import { SharingTab } from '../components/SharingTab';
import { TableMenu } from '../components/TableMenu';
import { UsageTab } from '../components/UsageTab';
import { useDatatable, useDatatableUsage } from '../hooks/queries';
import { canEditTable, gradeAtLeast } from '../model/access';
import { isSourceMirror, tableKindOf } from '../model/columns';
import { offersRetention } from '../model/retention';
import type { Datatable } from '../model/types';
import { gradeLabel } from '../model/words';

export type DatatableTab = 'columns' | 'rows' | 'retention' | 'sharing' | 'usage';
export const DATATABLE_TABS: readonly DatatableTab[] = ['columns', 'rows', 'retention', 'sharing', 'usage'];

function useTabs(table: Datatable | undefined): TabBarItem<DatatableTab>[] {
    const t = useTranslation();
    const usage = useDatatableUsage(table?.id ?? '');
    return [
        { id: 'columns', label: t('datatables.tab_columns', 'Columns'), icon: 'Table2' },
        { id: 'rows', label: t('datatables.tab_rows', 'Rows'), icon: 'List', count: table?.rowCount },
        ...(table && offersRetention(table) ? [{ id: 'retention' as const, label: t('datatables.tab_data', 'Data & retention'), icon: 'Timer' as const }] : []),
        { id: 'sharing', label: t('datatables.tab_sharing', 'Sharing'), icon: 'Share2' },
        { id: 'usage', label: t('datatables.tab_usage', 'Used by'), icon: 'Workflow', count: usage.data?.length },
    ];
}

function Body({ table, tab, canManage }: { table: Datatable; tab: DatatableTab; canManage: boolean }) {
    const canEdit = canEditTable(table, canManage);
    const canWrite = gradeAtLeast(table.grade, 'editor') && (!isSourceMirror(table) || table.sourceWritable !== false);
    switch (tab) {
        case 'rows':
            return <RowsTab table={table} canWrite={canWrite} />;
        case 'retention':
            return <RetentionTab table={table} canEdit={canEdit} />;
        case 'sharing':
            return <SharingTab table={table} canEdit={canEdit} />;
        case 'usage':
            return <UsageTab tableId={table.id} />;
        default:
            return <ColumnsTab table={table} canEdit={canEdit} />;
    }
}

export function DatatableScreen({ tableId, initialTab }: { tableId: string; initialTab?: DatatableTab }) {
    const t = useTranslation();
    const detail = useDatatable(tableId);
    const canManage = useHasPermission('manage_datatables');
    const table = detail.data ?? undefined;
    // A linked table opens on its rows: "how fresh is the copy" comes before "what are its columns".
    const [tab, setTab] = useState<DatatableTab>(initialTab ?? 'columns');
    const [seeded, setSeeded] = useState(initialTab !== undefined);
    if (!seeded && table) {
        setSeeded(true);
        if (isSourceMirror(table)) setTab('rows');
    }
    const tabs = useTabs(table);

    return (
        <QueryScreen
            query={{ ...detail, data: table, error: detail.error ?? new Error(t('datatables.not_available', 'That table is not available to you.')) }}
            scroll={false}
            header={(data) => (
                <ObjectHeader<DatatableTab>
                    kind={data ? tableKindOf(data) : 'datatable'}
                    title={data?.name ?? ''}
                    status={data ? gradeLabel(t, data.grade) : undefined}
                    backLabel={t('datatables.back', 'All datatables')}
                    extras={data ? <TableMenu table={data} canEdit={canEditTable(data, canManage)} canWrite={gradeAtLeast(data.grade, 'editor')} /> : null}
                    tabs={data ? tabs : undefined}
                    activeTab={tab}
                    onTab={setTab}
                    testID="datatable-header"
                />
            )}
        >
            {(data) => <Body table={data} tab={tab} canManage={canManage} />}
        </QueryScreen>
    );
}
