/**
 * The Data Act export matrix (web: pages/PortabilityPage): for every kind of
 * data the organisation holds, whether a portable export exists and in which
 * formats. Read-only — nothing is exported here.
 *
 * Server: routes/compliance/portability.js → exportRegistry.coverageMatrix.
 */

import React from 'react';
import type { ListRenderItem } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { QueryList } from '@/shared/patterns';
import { Badge, ListRow } from '@/shared/ui';

import type { PortabilityRow } from '../api/readersPages';
import { usePortability } from '../hooks/queries';

function PortabilityItem({ row }: { row: PortabilityRow }) {
    const t = useTranslation();
    const meta = [row.held === null ? null : t('mobile.compliance.held', '{n} held', { n: row.held }), row.formats.join(', ')].filter(Boolean).join(' · ');
    return (
        <ListRow
            testID={`portability-${row.kind}`}
            title={row.label_key ? t(row.label_key, row.kind) : row.kind}
            subtitle={meta || undefined}
            trailing={
                row.mounted ? (
                    <Badge label={t('mobile.compliance.exportable', 'Exportable')} tone="success" />
                ) : (
                    <Badge label={t('mobile.compliance.export_gap', 'Gap')} tone="warning" />
                )
            }
        />
    );
}

const renderItem: ListRenderItem<PortabilityRow> = ({ item }) => <PortabilityItem row={item} />;
const keyOf = (row: PortabilityRow) => row.kind;

export function PortabilityView() {
    const t = useTranslation();
    const matrix = usePortability(true);
    return (
        <QueryList
            query={matrix}
            renderItem={renderItem}
            keyExtractor={keyOf}
            empty={{ icon: 'Repeat', title: t('compliance.rail_portability', 'Data portability') }}
        />
    );
}
