/**
 * One register row: the registry's title, its summary line, the status chip.
 * The type and formatter come from the list's context, so FlatList's
 * `renderItem` can stay a module-level function.
 */

import { useRouter } from 'expo-router';
import React, { createContext, useContext } from 'react';
import type { ListRenderItem } from 'react-native';

import { Badge, ListRow } from '@/shared/ui';

import { labelText, statusOf, summaryOf } from '../model/fields';
import { recordRoute } from '../model/navigation';
import type { Formatter, Rec, RecordType } from '../model/types';

export interface RecordListContext {
    type: RecordType;
    fmt: Formatter;
}

export const RecordContext = createContext<RecordListContext | null>(null);

export function RecordRow({ rec }: { rec: Rec }) {
    const ctx = useContext(RecordContext);
    const router = useRouter();
    if (!ctx) return null;
    const { type, fmt } = ctx;
    const id = type.idOf(rec);
    const status = statusOf(type, rec);
    return (
        <ListRow
            testID={`record-${type.id}-${id}`}
            title={type.titleOf(rec, fmt)}
            subtitle={summaryOf(type, rec, fmt) ?? undefined}
            trailing={status ? <Badge label={labelText(status.label, fmt.t)} tone={status.tone ?? 'neutral'} /> : undefined}
            chevron
            onPress={() => router.push(recordRoute(type.id, id))}
        />
    );
}

export const renderRecord: ListRenderItem<Rec> = ({ item }) => <RecordRow rec={item} />;
