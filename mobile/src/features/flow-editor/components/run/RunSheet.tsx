/**
 * The last test run, step by step — the web builder's DryRunPanel as a tall
 * sheet: how it ended, how long it took and the run's own summary on top,
 * then one card per top-level step (RunStepCard) in the order they ran.
 * "Run again" repeats a dry run; "Clear" takes the run off the cards.
 */

import React, { createContext, useContext } from 'react';
import { FlatList, View, type ListRenderItem, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { statusLabel, statusToken } from '@/features/automations';
import type { DefinitionInput } from '@/features/flow-editor/model';
import { Button, EmptyState, Sheet, Text } from '@/shared/ui';

import { runRows, type RunRowModel } from './runRows';
import { RunStepCard } from './RunStepCard';
import type { TestRuns } from './useTestRuns';

const makeStyles = (theme: Theme) => ({
    list: { paddingBottom: theme.spacing[6] } satisfies ViewStyle,
    summary: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.md } satisfies ViewStyle,
    footer: { flexDirection: 'row', gap: theme.spacing.sm } satisfies ViewStyle,
    grow: { flex: 1 } satisfies ViewStyle,
});

const OpenContext = createContext<(stepId: string) => void>(() => undefined);

function Row({ row }: { row: RunRowModel }) {
    const onOpen = useContext(OpenContext);
    return <RunStepCard row={row} onOpenStep={onOpen} />;
}
const renderRow: ListRenderItem<RunRowModel> = ({ item }) => <Row row={item} />;
const keyOf = (row: RunRowModel) => row.key;

export interface RunSheetProps {
    visible: boolean;
    runs: TestRuns;
    definition: DefinitionInput;
    onClose: () => void;
    onOpenStep: (stepId: string) => void;
}

export function RunSheet({ visible, runs, definition, onClose, onOpenStep }: RunSheetProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const { state } = runs;
    const rows = runRows(state.rows, definition, t);
    const status = state.pending ? 'running' : state.run?.status ?? (state.error ? 'error' : null);
    const title = state.kind === 'dry' ? t('mobile.flow.run.dry_title', 'Dry-run preview') : t('mobile.flow.run.title', 'Test run');
    const subtitle = [
        status ? statusLabel(t, statusToken(status)) : null,
        rows.length === 1 ? t('routines.canvas.summary_step', '{n} step', { n: 1 }) : t('routines.canvas.summary_steps', '{n} steps', { n: rows.length }),
    ].filter(Boolean).join(' · ');
    const summary = state.run?.summary || state.error;
    const header = summary ? (
        <View style={styles.summary}>
            <Text variant="caption" tone={state.error ? 'error' : 'secondary'} numberOfLines={4}>
                {summary}
            </Text>
        </View>
    ) : null;
    const footer = (
        <View style={styles.footer}>
            <View style={styles.grow}>
                <Button label={t('common.clear', 'Clear')} variant="secondary" onPress={() => { runs.clear(); onClose(); }} fullWidth />
            </View>
            <View style={styles.grow}>
                <Button label={t('mobile.flow.run.again', 'Run again')} iconName="Play" onPress={runs.dryRun} loading={runs.running} fullWidth />
            </View>
        </View>
    );
    return (
        <Sheet visible={visible} onClose={onClose} title={title} subtitle={subtitle} scroll={false} tall footer={footer}>
            <OpenContext.Provider value={onOpenStep}>
                <FlatList
                    data={rows}
                    renderItem={renderRow}
                    keyExtractor={keyOf}
                    ListHeaderComponent={header}
                    ListEmptyComponent={
                        <EmptyState
                            icon="FlaskConical"
                            title={state.pending ? t('mobile.flow.run.waiting', 'Waiting for the first step…') : t('mobile.flow.run.none', 'This run recorded no steps')}
                        />
                    }
                    contentContainerStyle={styles.list}
                    testID="run-sheet-list"
                />
            </OpenContext.Provider>
        </Sheet>
    );
}
