/**
 * One step of a test run in the result sheet — a row of the web's
 * DryRunPanel: the step's name (tap to open it) and kind, how it ended and
 * how long it took, "sample data" when the output was synthesised, what a
 * dry run WOULD have done (notified whom, called what — "Gmail Send", not
 * `gmail_send` — with which arguments), else the output, drawn readably
 * (ValueTree); and the error, which a failed row shows open.
 */

import React, { useState } from 'react';
import { Pressable, View, type ViewStyle } from 'react-native';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { formatDuration, StatusIcon } from '@/features/automations';
import { humanizeToolName, nodeTypeLabel } from '@/features/flow-editor/model';
import { Badge, Button, Text } from '@/shared/ui';

import type { RunRowModel, SampleReason } from './runRows';
import { ValueTree } from './ValueTree';

const makeStyles = (theme: Theme) => ({
    card: {
        gap: theme.spacing.sm,
        padding: theme.spacing.md,
        marginHorizontal: theme.spacing.lg,
        marginBottom: theme.spacing.sm,
        borderRadius: theme.radii.md,
        borderWidth: 1,
        borderColor: theme.colors.borderDefault,
        backgroundColor: theme.colors.bgCard,
    } satisfies ViewStyle,
    head: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm } satisfies ViewStyle,
    name: { flex: 1 } satisfies ViewStyle,
});

function sampleHint(reason: SampleReason, t: TranslateFn): string {
    if (reason === 'live_failed') return t('mobile.flow.run.sample_failed', 'The live read failed, so a sample shape was used for this preview.');
    if (reason === 'live_empty') return t('mobile.flow.run.sample_empty', 'The live read returned nothing, so a sample shape was used for this preview.');
    return t('mobile.flow.run.sample_synth', 'Synthesized preview — sample data, not a live result.');
}

function Effect({ row }: { row: RunRowModel }) {
    const t = useTranslation();
    const [open, setOpen] = useState(false);
    if (row.notify) {
        return (
            <Text variant="caption" tone="warning">
                {t('mobile.flow.run.would_notify', 'Would notify on {channels}: {title}', { channels: row.notify.channels.join(', '), title: row.notify.title })}
            </Text>
        );
    }
    const value = row.call ? row.call.args : row.output;
    const hasValue = value !== undefined && value !== null;
    return (
        <>
            {row.call ? (
                <Text variant="caption" tone="warning">
                    {t('mobile.flow.run.would_call', 'Would call {tool}', { tool: humanizeToolName(row.call.tool) || row.call.tool })}
                </Text>
            ) : null}
            {hasValue ? (
                <Button
                    size="sm"
                    variant="ghost"
                    iconName={open ? 'ChevronDown' : 'ChevronRight'}
                    label={row.call ? t('mobile.flow.run.arguments', 'Arguments') : t('routines.ndv.output', 'Output')}
                    onPress={() => setOpen((v) => !v)}
                />
            ) : null}
            {hasValue && open ? <ValueTree value={value} testID={`run-value-${row.stepId}`} /> : null}
        </>
    );
}

export function RunStepCard({ row, onOpenStep }: { row: RunRowModel; onOpenStep: (stepId: string) => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const kind = row.stepType ? nodeTypeLabel(row.stepType, t) || row.stepType : null;
    const meta = [kind, row.durationMs == null ? null : formatDuration(row.durationMs)].filter(Boolean).join(' · ');
    return (
        <View style={styles.card} testID={`run-row-${row.stepId}`}>
            <View style={styles.head}>
                <StatusIcon status={row.status} size={16} />
                <Pressable
                    style={styles.name}
                    onPress={() => onOpenStep(row.stepId)}
                    accessibilityRole="link"
                    accessibilityHint={t('mobile.flow.run.open_step', 'Opens this step')}
                >
                    <Text variant="body" weight="medium" numberOfLines={1}>
                        {row.name}
                    </Text>
                    {meta ? (
                        <Text variant="caption" tone="tertiary" numberOfLines={1}>
                            {meta}
                        </Text>
                    ) : null}
                </Pressable>
                {row.sample ? <Badge label={t('mobile.flow.run.sample', 'Sample data')} tone="warning" /> : null}
            </View>
            {row.sample ? (
                <Text variant="caption" tone="tertiary">
                    {sampleHint(row.sample, t)}
                </Text>
            ) : null}
            <Effect row={row} />
            {row.error ? (
                <Text variant="caption" tone="error" selectable>
                    {row.error}
                </Text>
            ) : null}
        </View>
    );
}
