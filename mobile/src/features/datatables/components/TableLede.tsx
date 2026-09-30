/** The line above a tab's content (the web's `table-lede`): the purpose, then "6 columns · 412 rows". */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { Text } from '@/shared/ui';

import type { Datatable } from '../model/types';
import { columnsWord, rowsWord } from '../model/words';

export function TableLede({ table, columnCount }: { table: Datatable; columnCount?: number }) {
    const t = useTranslation();
    const counts = [columnCount === undefined ? null : columnsWord(t, columnCount), rowsWord(t, table.rowCount)]
        .filter(Boolean)
        .join(' · ');
    return (
        <>
            {table.description ? (
                <Text variant="body" tone="secondary">
                    {table.description}
                </Text>
            ) : null}
            <Text variant="caption" tone="tertiary" testID="table-meta">
                {counts}
            </Text>
        </>
    );
}
