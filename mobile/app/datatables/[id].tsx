/**
 * One datatable. `?tab=` opens a section (columns, rows, retention, sharing,
 * usage) — the phone's half of the web's `/app/studio/datatables/<id>/<tab>`.
 * The screen lives in features/datatables.
 */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { DATATABLE_TABS, DatatableScreen, type DatatableTab } from '@/features/datatables';

export default function DatatableRoute() {
    const params = useLocalSearchParams<{ id: string; tab?: string }>();
    const tab = DATATABLE_TABS.find((x) => x === params.tab);
    return <DatatableScreen tableId={typeof params.id === 'string' ? params.id : ''} initialTab={tab as DatatableTab | undefined} />;
}
