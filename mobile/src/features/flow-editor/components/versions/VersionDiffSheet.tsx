/**
 * One saved version, compared — the web panel's DiffModal as a tall sheet.
 * By default against the routine as it is saved now; "Compare with" picks
 * another saved version instead (then the server's diff route answers, with
 * its list of steps by name). The plain-language summary comes first; "Raw
 * JSON" swaps it for the changed lines. Restore is offered unless this IS
 * the current version.
 */

import React, { useState } from 'react';
import { FlatList, View, type ListRenderItem, type TextStyle, type ViewStyle } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { FlowVersionSummary } from '@/features/flow-editor/api';
import { useVersion, useVersionDiff } from '@/features/flow-editor/hooks';
import type { FlowDefinition } from '@/features/flow-editor/model';
import { ActionMenu, Banner, Button, Chip, Sheet, Spinner, Text, tint } from '@/shared/ui';

import { diffItems, type DiffItem } from './diffView';

const makeStyles = (theme: Theme) => ({
    controls: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm, paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.md } satisfies ViewStyle,
    heading: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm } satisfies ViewStyle,
    phrase: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm, paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.xs } satisfies ViewStyle,
    dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.accentPrimary } satisfies ViewStyle,
    line: { paddingHorizontal: theme.spacing.lg } satisfies TextStyle,
    del: { backgroundColor: tint(theme.colors.error, 12) } satisfies ViewStyle,
    ins: { backgroundColor: tint(theme.colors.success, 12) } satisfies ViewStyle,
    list: { paddingBottom: theme.spacing[6] } satisfies ViewStyle,
    banner: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm } satisfies ViewStyle,
});

function Item({ item }: { item: DiffItem }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    if (item.kind === 'phrase') {
        return (
            <View style={styles.phrase}>
                <View style={styles.dot} />
                <Text variant="body">{item.text}</Text>
            </View>
        );
    }
    if (item.kind === 'none') {
        return (
            <Text variant="caption" tone="tertiary" style={styles.line}>
                {t('mobile.flow.versions.no_changes', 'No structural changes — only formatting or key ordering differs.')}
            </Text>
        );
    }
    if (item.kind === 'gap') {
        return <Text variant="code" tone="tertiary" style={styles.line}>{t('mobile.flow.versions.unchanged', '⋯ {n} unchanged lines', { n: item.count })}</Text>;
    }
    const mark = item.kind === 'del' ? '−' : item.kind === 'ins' ? '+' : ' ';
    const tone = item.kind === 'del' ? 'error' : item.kind === 'ins' ? 'success' : 'secondary';
    return (
        <View style={item.kind === 'del' ? styles.del : item.kind === 'ins' ? styles.ins : null}>
            <Text variant="code" tone={tone} style={styles.line}>{`${mark} ${item.text}`}</Text>
        </View>
    );
}
/** The menu does not scroll: the most recent saves are the ones worth comparing. */
const COMPARE_CHOICES = 12;

const renderItem: ListRenderItem<DiffItem> = ({ item }) => <Item item={item} />;
const keyOf = (item: DiffItem) => item.key;

export interface VersionDiffSheetProps {
    automationId: string;
    version: FlowVersionSummary;
    versions: readonly FlowVersionSummary[];
    currentVersion: number | null;
    /** The routine as the server holds it now. */
    currentDefinition: FlowDefinition | null;
    restoring: boolean;
    onRestore: (version: FlowVersionSummary) => void;
    onClose: () => void;
}

/** The two definitions being compared, the rows between them, and the words for the other side. */
function useComparison({ automationId, version, currentVersion, currentDefinition }: VersionDiffSheetProps, compareWith: FlowVersionSummary | null, raw: boolean) {
    const t = useTranslation();
    const opened = useVersion(automationId, version.id);
    const diff = useVersionDiff(automationId, compareWith?.id ?? null, compareWith ? version.id : null);
    const pair = compareWith
        ? { before: diff.data?.a?.definition, after: diff.data?.b?.definition, summary: diff.data?.summary ?? null }
        : { before: currentDefinition, after: opened.data?.definition, summary: null };
    return {
        items: diffItems(pair.before, pair.after, { raw, summary: pair.summary, t }),
        error: opened.error ?? diff.error,
        label: compareWith ? `v${compareWith.version}` : t('mobile.flow.versions.current_n', 'current (v{n})', { n: currentVersion ?? '—' }),
    };
}

function Controls({ label, raw, error, version, onPick, onRaw }: {
    label: string; raw: boolean; error: unknown; version: FlowVersionSummary; onPick: () => void; onRaw: () => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <>
            <View style={styles.controls}>
                <Chip label={t('mobile.flow.versions.compare_with', 'Compare with: {what}', { what: label })} onPress={onPick} testID="diff-compare" />
                <Chip label={t('mobile.flow.versions.raw', 'Raw JSON')} selected={raw} onPress={onRaw} testID="diff-raw" />
            </View>
            {error ? <View style={styles.banner}><Banner tone="error">{describeError(error).message}</Banner></View> : null}
            <Text variant="label" tone="tertiary" style={styles.heading}>
                {t('mobile.flow.versions.changes_in', 'Changes in v{n} vs {what}', { n: version.version, what: label }).toUpperCase()}
            </Text>
        </>
    );
}

export function VersionDiffSheet(props: VersionDiffSheetProps) {
    const { version, versions, currentVersion, restoring, onRestore, onClose } = props;
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [compareWith, setCompareWith] = useState<FlowVersionSummary | null>(null);
    const [raw, setRaw] = useState(false);
    const [picking, setPicking] = useState(false);
    const { items, error, label } = useComparison(props, compareWith, raw);
    const isCurrent = currentVersion != null && version.version === currentVersion;
    const footer = isCurrent ? undefined : (
        <Button label={t('mobile.flow.versions.restore_this', 'Restore this version')} iconName="RotateCcw" onPress={() => onRestore(version)} loading={restoring} fullWidth size="lg" />
    );
    return (
        <Sheet
            visible
            onClose={onClose}
            title={t('mobile.flow.versions.diff_title', 'Version {n}', { n: version.version })}
            subtitle={version.savedAt ? new Date(version.savedAt).toLocaleString() : undefined}
            scroll={false}
            tall
            footer={footer}
        >
            <FlatList
                data={items ?? []}
                renderItem={renderItem}
                keyExtractor={keyOf}
                ListHeaderComponent={
                    <Controls label={label} raw={raw} error={error} version={version} onPick={() => setPicking(true)} onRaw={() => setRaw((v) => !v)} />
                }
                ListEmptyComponent={error ? null : <Spinner />}
                contentContainerStyle={styles.list}
                testID="version-diff"
            />
            <ActionMenu
                visible={picking}
                onClose={() => setPicking(false)}
                title={t('mobile.flow.versions.compare_title', 'Compare with')}
                items={[
                    { id: 'current', label: t('mobile.flow.versions.current_word', 'Current'), selected: !compareWith, onPress: () => setCompareWith(null) },
                    ...versions.filter((v) => v.id !== version.id).slice(0, COMPARE_CHOICES).map((v) => ({
                        id: v.id, label: `v${v.version}`, selected: compareWith?.id === v.id, onPress: () => setCompareWith(v),
                    })),
                ]}
            />
        </Sheet>
    );
}
