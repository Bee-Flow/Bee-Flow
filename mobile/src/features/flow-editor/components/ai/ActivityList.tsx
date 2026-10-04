/**
 * What the AI did, while it is doing it — the web's BuilderActivity: one
 * numbered row per tool call, in the family colour of the step it made, a
 * tick when done, a warning when refused (refusals open themselves: the
 * reason is the point), a spinner on the live row. A batch lists the steps
 * it made under its row. The raw payload the web shows behind "details" is
 * left out: a refusal's words and hint are what a phone has room for.
 */

import React, { useState } from 'react';
import { Pressable, View, type TextStyle, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { FlowNode } from '@/features/flow-editor/bindings';
import { Icon, Spinner, Text, tint } from '@/shared/ui';

import type { ActivityRow } from './activity';
import { FamilyTile } from '../nodeEditor/FamilyTile';

const makeStyles = (theme: Theme) => ({
    box: {
        gap: theme.spacing.xs, padding: theme.spacing.sm, marginTop: theme.spacing.xs, borderRadius: theme.radii.md,
        borderWidth: 1, borderColor: theme.colors.borderDefault, backgroundColor: tint(theme.colors.bgSecondary, 50),
    } satisfies ViewStyle,
    head: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs } satisfies ViewStyle,
    row: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm, minHeight: 32 } satisfies ViewStyle,
    words: { flex: 1 } satisfies ViewStyle,
    more: { paddingLeft: 44, gap: 2 } satisfies ViewStyle,
    reason: { paddingLeft: 44 } satisfies TextStyle,
    problem: { padding: theme.spacing.sm, borderRadius: theme.radii.sm, backgroundColor: tint(theme.colors.warning, 10) } satisfies ViewStyle,
    glyph: { color: theme.colors.textSecondary },
    ok: { color: theme.colors.success },
    warn: { color: theme.colors.warning },
});

/** The tile of the step a row made: its family and glyph, or a wrench for a call that made none. */
function RowTile({ row }: { row: ActivityRow }) {
    const styles = useThemedStyles(makeStyles);
    if (row.status === 'running') return <Icon name="FlaskConical" size={16} color={styles.glyph.color} />;
    if (row.steps.length > 1) return <Icon name="Layers" size={16} color={styles.glyph.color} />;
    if (!row.type) return <Icon name="Wrench" size={16} color={styles.glyph.color} />;
    return <FamilyTile step={{ id: '', type: row.type } as FlowNode} size={20} error={row.status === 'failed'} />;
}

function StatusGlyph({ row, active }: { row: ActivityRow; active: boolean }) {
    const styles = useThemedStyles(makeStyles);
    if (active) return <Spinner />;
    if (row.status === 'failed') return <Icon name="TriangleAlert" size={14} color={styles.warn.color} />;
    return <Icon name="Check" size={14} color={styles.ok.color} />;
}

function Row({ row, n, active }: { row: ActivityRow; n: number; active: boolean }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [open, setOpen] = useState(row.status === 'failed');
    const batch = row.steps.length > 1;
    return (
        <View>
            <Pressable style={styles.row} onPress={() => setOpen((v) => !v)} accessibilityRole="button" accessibilityState={{ expanded: open }}>
                <Text variant="caption" tone="tertiary">{String(n)}</Text>
                <RowTile row={row} />
                <View style={styles.words}>
                    <Text variant="caption" weight="medium" numberOfLines={1}>{row.title}</Text>
                    {row.detail ? <Text variant="caption" tone="tertiary" numberOfLines={open ? undefined : 1}>{row.detail}</Text> : null}
                </View>
                <StatusGlyph row={row} active={active} />
            </Pressable>
            {open && (batch || row.error) ? (
                <View style={styles.more}>
                    {batch ? row.steps.map((s, i) => <Text key={s.id ?? i} variant="caption" tone="secondary" numberOfLines={1}>{`· ${s.title}`}</Text>) : null}
                    {row.error ? (
                        <View style={styles.problem}>
                            <Text variant="caption">{row.error}</Text>
                            {row.hint ? <Text variant="caption" tone="secondary">{row.hint}</Text> : null}
                        </View>
                    ) : null}
                </View>
            ) : null}
            {!open && row.error ? <Text variant="caption" tone="tertiary" style={styles.reason}>{t('mobile.flow.ai.tap_reason', 'Tap for the reason')}</Text> : null}
        </View>
    );
}

export function ActivityList({ rows, running }: { rows: readonly ActivityRow[]; running: boolean }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    if (!rows.length) return null;
    const failed = rows.filter((r) => r.status === 'failed').length;
    return (
        <View style={styles.box} testID="ai-activity">
            <View style={styles.head}>
                <Icon name={running ? 'LoaderCircle' : 'Wrench'} size={13} color={styles.glyph.color} />
                <Text variant="caption" weight="medium" tone="secondary">
                    {running ? t('automations.builder.act.building', 'Building') : t('automations.builder.act.built', 'Built')}
                </Text>
                <Text variant="caption" tone="tertiary">{String(rows.length)}</Text>
                {failed ? <Text variant="caption" tone="warning">{`⚠ ${failed}`}</Text> : null}
            </View>
            {rows.map((row, i) => (
                <Row key={i} row={row} n={i + 1} active={running && i === rows.length - 1} />
            ))}
        </View>
    );
}
