/**
 * One table in the list — the web's DatatableCard, as a row: what KIND of
 * table it is, what it is for and what you may do with it, how many rows it
 * holds, whether anything uses it, and who else can see it.
 */

import React, { memo } from 'react';

import { useTranslation } from '@/core/i18n';
import { Badge, KindTile, ListRow } from '@/shared/ui';

import { audienceOf } from '../model/access';
import { tableKindOf } from '../model/columns';
import type { Datatable } from '../model/types';
import { audienceLabel, gradeLabel, rowsWord } from '../model/words';

function usageText(t: ReturnType<typeof useTranslation>, n: number): string {
    if (!n) return t('datatables.usage_none_short', 'not used yet');
    return n === 1 ? t('datatables.usage_count_one', 'used by 1') : t('datatables.usage_count', 'used by {n}', { n });
}

function DatatableRowView({ table, onOpen }: { table: Datatable; onOpen: (id: string) => void }) {
    const t = useTranslation();
    const shared = table.scopeKind === 'org' && audienceOf(table) !== 'private';
    return (
        <ListRow
            title={table.name}
            subtitle={`${table.description || t('datatables.no_description', 'No description')} · ${gradeLabel(t, table.grade)}`}
            meta={`${rowsWord(t, table.rowCount)} · ${usageText(t, table.usageCount)}`}
            leading={<KindTile kind={tableKindOf(table)} size={36} />}
            trailing={<Badge label={audienceLabel(t, table)} tone={shared ? 'info' : 'neutral'} />}
            onPress={() => onOpen(table.id)}
            chevron
            testID={`datatable-${table.id}`}
        />
    );
}

/** A list cell, so memoised: a row whose table did not change has nothing to redraw. */
export const DatatableRow = memo(DatatableRowView);
