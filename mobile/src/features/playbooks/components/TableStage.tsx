/**
 * The table phase: the server creates (or checks) the table, and the stage
 * shows it arriving — its columns, and for an existing table which column
 * plays which part. Nothing to press; the handoff card below asks.
 */

import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Badge, Text } from '@/shared/ui';

import { StageCard } from './StageCard';
import { artNum, artRecord, artRecords, artStr, textOf } from '../model/artifacts';
import type { Phase, Playbook } from '../model/types';

function statusLine(phase: Phase, existing: boolean, t: ReturnType<typeof useTranslation>): string | null {
    if (phase.status === 'failed') return t('playbooks.table.failed', 'The table did not land');
    if (phase.status === 'ready' || phase.status === 'running') {
        return existing ? t('playbooks.table.checking', 'Checking the columns…') : t('playbooks.table.creating', 'Creating the table…');
    }
    if (phase.status !== 'awaiting' && phase.status !== 'done') return null;
    const rows = artNum(phase.artifacts, 'rowCount');
    const ready = t('playbooks.table.ready', 'Table ready');
    return rows !== null ? `${ready} · ${t('playbooks.table.rows', '{n} rows', { n: rows })}` : ready;
}

export function TableStage({ playbook, phase }: { playbook: Playbook; phase: Phase }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const a = phase.artifacts;
    const fields = artRecords(a, 'fields');
    const mapping = artRecord(a, 'mapping');
    const landed = phase.status === 'awaiting' || phase.status === 'done';
    const roleOf = (key: string) => (mapping ? Object.keys(mapping).find((r) => mapping[r] === key) ?? null : null);
    return (
        <StageCard
            kind="datatable"
            title={artStr(a, 'datatableName') || t('playbooks.table.pending_name', 'The table')}
            status={statusLine(phase, playbook.options.tableMode === 'existing', t)}
            tone={phase.status === 'failed' ? 'error' : landed ? 'quiet' : 'busy'}
            testID="playbook-stage-table"
        >
            {a.isMirror ? <Badge label={t('playbooks.table.mirror', 'Nextcloud mirror')} tone="ai" icon="Cloud" /> : null}
            {fields.length === 0 && landed ? (
                <Text variant="caption" tone="secondary">
                    {t('playbooks.table.no_columns', 'The table landed, but it has no columns yet.')}
                </Text>
            ) : null}
            {fields.map((f) => {
                const role = roleOf(textOf(f, 'key'));
                return (
                    <View key={textOf(f, 'key')} style={styles.column} testID="playbook-table-column">
                        <Text variant="caption" weight="medium" style={styles.grow} numberOfLines={1}>
                            {role ? '✓ ' : ''}
                            {textOf(f, 'name') || textOf(f, 'key')}
                        </Text>
                        <Text variant="label" tone="tertiary">
                            {[textOf(f, 'type'), role].filter(Boolean).join(' · ')}
                        </Text>
                    </View>
                );
            })}
            {landed && mapping && a.hasStatus === false ? (
                <Text variant="caption" tone="secondary">
                    {t('playbooks.table.no_status', 'No status column — the approval flow will be skipped.')}
                </Text>
            ) : null}
            {landed && artStr(a, 'datatableKey') ? (
                <Text variant="label" tone="tertiary">
                    {`${t('playbooks.inspect.key', 'Key')}: ${artStr(a, 'datatableKey')}`}
                </Text>
            ) : null}
        </StageCard>
    );
}

const makeStyles = (theme: Theme) => ({
    column: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: theme.spacing[2],
        paddingHorizontal: theme.spacing[2.5],
        paddingVertical: theme.spacing[2],
        borderRadius: theme.radii.sm,
        borderWidth: 1,
        borderColor: theme.colors.borderDefault,
        backgroundColor: theme.colors.bgPrimary,
    },
    grow: { flex: 1 },
});
