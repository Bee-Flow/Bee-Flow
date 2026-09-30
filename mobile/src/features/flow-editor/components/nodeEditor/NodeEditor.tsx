/**
 * One step, edited — the web's Node Detail View (agent-hub `Builder/
 * NodeDetailView.jsx`) for a phone: its three columns become three tabs,
 * Input | Settings | Output, under a header that names the step, pages to the
 * previous and next step in run order and tests it. Settings stays mounted
 * while another tab shows, so a field picked in Input lands where the author
 * was typing, and nothing typed is lost to a tab switch.
 */

import React, { useEffect, useRef, useState } from 'react';
import { View, type TextInput, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { FlowDraft } from '@/features/flow-editor/hooks';
import { buildStepTypeMap } from '@/features/flow-editor/model';
import { Screen, TabBar } from '@/shared/ui';

import { VariablePickerProvider } from '../variables';
import { headerKicker, headerTitle } from './headerText';
import { InputPane } from './InputPane';
import { OutputPane } from './OutputPane';
import { SaveChip } from './SaveChip';
import { SettingsPane } from './SettingsPane';
import { StepHeader } from './StepHeader';
import { useNodeEditor } from './useNodeEditor';

export type NodeEditorTab = 'input' | 'settings' | 'output';

export interface NodeEditorProps {
    flow: FlowDraft;
    /** The step's id, or a held step's address (outline/nested.ts). */
    stepId: string;
    /** The settings section to open first — the one a finding points at. */
    section?: string | null;
    /** The flowlet the step lives in; `flow` is then scoped to it. */
    flowlet?: string | null;
    onPage: (stepId: string) => void;
}

export function NodeEditor({ flow, stepId, section = null, flowlet = null, onPage }: NodeEditorProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const model = useNodeEditor(flow, stepId, section, flowlet);
    const [tab, setTab] = useState<NodeEditorTab>('settings');
    const [outputSeen, setOutputSeen] = useState(false);
    if (tab === 'output' && !outputSeen) setOutputSeen(true);
    const nameRef = useRef<TextInput>(null);
    const [focusName, setFocusName] = useState(0);
    useEffect(() => {
        if (focusName) nameRef.current?.focus();
    }, [focusName]);

    const step = model.form.step;
    if (!step) return null;
    const test = () => {
        model.testStep();
        setTab('output');
    };
    const issueCount = model.stepIssues.errors.length + model.stepIssues.warnings.length;
    return (
        <Screen edges={['top', 'bottom']} avoidKeyboard>
            <View style={styles.header}>
                <StepHeader
                    step={step}
                    title={headerTitle(step, model.ctx.catalog)}
                    kicker={headerKicker(step, model.position, t)}
                    position={model.position}
                    onPage={onPage}
                    onRename={() => {
                        setTab('settings');
                        setFocusName((n) => n + 1);
                    }}
                    onTest={test}
                    testing={model.testing}
                    canTest={model.canTest}
                    status={<SaveChip store={flow.store} />}
                />
                <TabBar
                    value={tab}
                    onChange={setTab}
                    testID="step-tabs"
                    accessibilityLabel={t('routines.ndv.drawer_columns', 'Drawer columns')}
                    items={[
                        { id: 'input', label: t('mobile.flow.ndv.input', 'Input'), count: model.groups.length || null },
                        { id: 'settings', label: t('routines.ndv.settings', 'Settings'), count: issueCount || null },
                        { id: 'output', label: t('routines.ndv.output', 'Output') },
                    ]}
                />
            </View>
            <VariablePickerProvider
                groups={model.groups}
                sampleRoot={model.ctx.sampleRoot}
                stepLabelById={model.ctx.stepLabelById}
                stepTypeById={buildStepTypeMap(model.ctx.definition)}
                simple={model.ctx.mode === 'simple'}
            >
                <View style={tab === 'settings' ? styles.pane : styles.hidden}>
                    <SettingsPane form={model.form} ctx={model.ctx} issues={model.stepIssues} onMode={model.setMode} nameRef={nameRef} />
                </View>
                {tab === 'input' ? <InputPane onInserted={() => setTab('settings')} /> : null}
                {/* Kept once opened, hidden on another tab: a half-typed output
                    in its editor survived no tab switch before. */}
                {outputSeen ? (
                    <View style={tab === 'output' ? styles.pane : styles.hidden}>
                        <OutputPane
                            step={step}
                            runStep={model.runStep}
                            testError={model.testError}
                            testing={model.testing}
                            onTest={model.testStep}
                            canTest={model.canTest}
                            patchStep={model.form.patchStep}
                            disabled={model.ctx.disabled}
                        />
                    </View>
                ) : null}
            </VariablePickerProvider>
        </Screen>
    );
}

const makeStyles = (theme: Theme) => ({
    header: {
        backgroundColor: theme.colors.bgSecondary,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.borderDefault,
    } satisfies ViewStyle,
    pane: { flex: 1 } satisfies ViewStyle,
    hidden: { display: 'none' } satisfies ViewStyle,
});
