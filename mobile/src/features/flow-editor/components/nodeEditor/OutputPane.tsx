/**
 * The Output tab — the web's "Continues on" column: what this step produced
 * the last time it was tested here (its status, its error, its output), or —
 * when there is one — the pinned or hand-written output the steps after it
 * will see, badged Pinned / Edited with the last test's status under it. Pin
 * keeps a real output and replays it instead of running the step, Edit
 * writes one by hand (OutputEditor) and opens on what is shown.
 *
 * The output is drawn readably first (outputView: ValuePreview's table,
 * fields, list or text, else a tree in words) and as the exact JSON tree
 * behind "Show raw". The tree is a FlatList, so a large output scrolls
 * without rendering all of it.
 */

import * as Clipboard from 'expo-clipboard';
import React, { createContext, useContext, useState } from 'react';
import { FlatList, View, type ListRenderItem, type ViewStyle } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { RawToggle, StatusIcon, statusLabel, statusToken, ValuePreview, type AutomationRunStep } from '@/features/automations';
import type { FlowNode } from '@/features/flow-editor/bindings';
import { Badge, Banner, Button, Text, useToast } from '@/shared/ui';

import { JsonRow } from './JsonRow';
import { copyText, treeRows, treeWords, type TreeRow } from './jsonTree';
import { editedOutputPatch, outputSeed, outputState, pinPatch, shownOutput, unpinPatch, type OutputState } from './outputEdit';
import { OutputEditor } from './OutputEditor';
import { outputView, type OutputView } from './outputView';

interface RowActions {
    onToggle: (id: string) => void;
    onCopy: (row: TreeRow) => void;
    readable: boolean;
}
const RowActionsContext = createContext<RowActions>({ onToggle: () => undefined, onCopy: () => undefined, readable: false });

function Row({ row }: { row: TreeRow }) {
    const { onToggle, onCopy, readable } = useContext(RowActionsContext);
    return <JsonRow row={row} onToggle={onToggle} onCopy={onCopy} readable={readable} />;
}
const renderRow: ListRenderItem<TreeRow> = ({ item }) => <Row row={item} />;
const keyOf = (row: TreeRow) => row.id;

export interface OutputPaneProps {
    step: FlowNode;
    runStep: AutomationRunStep | null;
    testError: Error | null;
    testing: boolean;
    onTest: () => void;
    patchStep: (patch: Record<string, unknown>) => void;
    disabled: boolean;
    /** The header's rule: a step held in a loop, a branch or a flowlet, or a note, has no test run of its own. */
    canTest: boolean;
}

function LastRun({ runStep, secondary }: { runStep: AutomationRunStep; secondary: boolean }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const word = statusLabel(t, statusToken(runStep.status));
    return (
        <View style={styles.status} testID="output-run-status">
            <StatusIcon status={runStep.status} step={runStep} />
            {secondary ? (
                <Text variant="caption" tone="tertiary">
                    {t('mobile.flow.ndv.last_test', 'Last test: {status}', { status: word })}
                </Text>
            ) : (
                <Text variant="caption" weight="medium">
                    {word}
                </Text>
            )}
        </View>
    );
}

function RunStatus({ runStep, state }: { runStep: AutomationRunStep | null; state: OutputState }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    if (state.pinned) {
        // What is shown is the pin, so the pin is what the badge names; the
        // last test is still worth a line, but it is not what you are reading.
        return (
            <View style={styles.statusStack}>
                <Badge tone="pinned" icon="Pin" label={state.edited ? t('routines.ndv.edited', 'Edited') : t('routines.ndv.pinned', 'Pinned')} />
                {runStep ? <LastRun runStep={runStep} secondary /> : null}
            </View>
        );
    }
    if (runStep) return <LastRun runStep={runStep} secondary={false} />;
    return (
        <Text variant="caption" tone="tertiary">
            {t('routines.ndv.not_run_yet', 'not run yet')}
        </Text>
    );
}

interface HeadProps extends OutputPaneProps {
    editing: boolean;
    setEditing: (v: boolean) => void;
    value: unknown;
    view: OutputView;
    raw: boolean;
    onToggleRaw: () => void;
}

function OutputActions({ runStep, onTest, testing, canTest, patchStep, disabled, state, setEditing }: HeadProps & { state: OutputState }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.actions}>
            {canTest ? <Button size="sm" iconName="Play" label={t('routines.ndv.test_step', 'Test step')} onPress={onTest} loading={testing} disabled={disabled} testID="output-test" /> : null}
            {state.pinned ? (
                <Button size="sm" variant="secondary" iconName="PinOff" label={t('routines.ndv.clear', 'Clear')} onPress={() => patchStep(unpinPatch())} disabled={disabled} accessibilityHint={t('routines.ndv.unpin_title', 'Unpin output (re-enable live execution)')} testID="output-clear" />
            ) : (
                <Button size="sm" variant="secondary" iconName="Pin" label={t('routines.ndv.pin', 'Pin')} onPress={() => patchStep(pinPatch(runStep?.output))} disabled={disabled || !state.canPin} accessibilityHint={t('routines.ndv.pin_title', 'Pin this output (skip live execution; reuse the latest output)')} testID="output-pin" />
            )}
            <Button size="sm" variant="ghost" iconName="Pencil" label={t('routines.ndv.edit', 'Edit')} onPress={() => setEditing(true)} disabled={disabled} accessibilityHint={t('routines.ndv.edit_output_hint', 'Write this step\'s output by hand, so the steps after it can be built and tested before this one has ever run')} testID="output-edit" />
        </View>
    );
}

function Head(props: HeadProps) {
    const { step, runStep, testError, patchStep, editing, setEditing, value, view, raw, onToggleRaw } = props;
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const state = outputState(step, runStep?.output);
    const error = runStep?.error ?? null;
    return (
        <View style={styles.head}>
            <RunStatus runStep={runStep} state={state} />
            {testError ? <Banner tone="error">{describeError(testError).message}</Banner> : null}
            {error ? <Banner tone="error">{error}</Banner> : null}
            {editing ? (
                <OutputEditor
                    seed={outputSeed(value, step.pinnedOutput, undefined)}
                    canRemove={state.pinned}
                    onSave={(next) => {
                        patchStep(editedOutputPatch(next));
                        setEditing(false);
                    }}
                    onRemove={() => {
                        patchStep(unpinPatch());
                        setEditing(false);
                    }}
                    onCancel={() => setEditing(false)}
                />
            ) : (
                <>
                    <OutputActions {...props} state={state} />
                    {view.canToggle ? (
                        <View style={styles.toggle}>
                            <RawToggle value={value} raw={raw} onToggle={onToggleRaw} subject={t('routines.ndv.output', 'Output')} testID="output-raw" />
                        </View>
                    ) : null}
                    {view.body === 'preview' ? <ValuePreview value={value} bare /> : null}
                </>
            )}
        </View>
    );
}

export function OutputPane(props: OutputPaneProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const { toast } = useToast();
    const [editing, setEditing] = useState(false);
    const [raw, setRaw] = useState(false);
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
    const value = shownOutput(props.step, props.runStep?.output);
    const view = outputView(value, raw);
    const rows = view.body === 'tree' && !editing ? treeRows(value, expanded, undefined, view.readableTree ? treeWords(t) : null) : [];
    const actions: RowActions = {
        onToggle: (id) =>
            setExpanded((prev) => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
            }),
        onCopy: (row) => {
            void Clipboard.setStringAsync(copyText(row.value));
            toast(t('common.copied', 'Copied to clipboard'), 'success');
        },
        readable: view.readableTree,
    };
    const head = <Head {...props} editing={editing} setEditing={setEditing} value={value} view={view} raw={raw} onToggleRaw={() => setRaw((v) => !v)} />;
    return (
        <RowActionsContext.Provider value={actions}>
            <FlatList
                testID="output-pane"
                data={rows}
                keyExtractor={keyOf}
                renderItem={renderRow}
                ListHeaderComponent={head}
                contentContainerStyle={styles.content}
                keyboardShouldPersistTaps="handled"
            />
        </RowActionsContext.Provider>
    );
}

const makeStyles = (theme: Theme) => ({
    content: { paddingBottom: theme.spacing.xxxl } satisfies ViewStyle,
    head: { gap: theme.spacing.md, padding: theme.spacing.lg } satisfies ViewStyle,
    status: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm } satisfies ViewStyle,
    statusStack: { alignItems: 'flex-start', gap: theme.spacing.xs } satisfies ViewStyle,
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm } satisfies ViewStyle,
    toggle: { flexDirection: 'row', justifyContent: 'flex-end' } satisfies ViewStyle,
});
