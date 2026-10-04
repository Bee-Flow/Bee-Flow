/**
 * The Settings tab — the web's SettingsForm frame around the per-type editor:
 * what is wrong with the step first, then what the step does (NodePurpose),
 * how much of the form to show (Simple / All options), its name, symbol and
 * Disable switch (StepBasics), and the editor the registry picks for its type. Every change saves on its own.
 */

import React, { type RefObject } from 'react';
import { ScrollView, View, type TextInput, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { nodeHelp, type StepIssues } from '@/features/flow-editor/model';
import { Banner, Segmented, Text } from '@/shared/ui';

import { IssueList } from './IssueList';
import { StepBasics } from './StepBasics';
import type { StepFormState } from './useStepForm';
import { renderStepEditor } from '../editors/registry';
import type { FormMode, StepEditorContext } from '../editors/types';

export function SettingsPane({
    form,
    ctx,
    issues,
    onMode,
    nameRef,
}: {
    form: StepFormState;
    ctx: StepEditorContext;
    issues: StepIssues;
    onMode: (mode: FormMode) => void;
    nameRef: RefObject<TextInput | null>;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const step = form.step;
    if (!step) return null;
    const purpose = nodeHelp(String(step.type), t);
    return (
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body} testID="settings-pane">
            {ctx.disabled ? (
                <Banner tone="info">{t('automations.builder.edits_locked', 'The AI is building this automation — editing is paused until it finishes.')}</Banner>
            ) : null}
            <IssueList issues={issues} labels={ctx.stepLabelById instanceof Map ? ctx.stepLabelById : new Map()} />
            {purpose ? (
                <Text variant="caption" tone="secondary">
                    {purpose}
                </Text>
            ) : null}
            <View style={styles.mode}>
                <Segmented
                    value={ctx.mode}
                    onChange={onMode}
                    fullWidth
                    accessibilityLabel={t('automations.builder.mode_toggle_label', 'How much of this step to show')}
                    options={[
                        { value: 'simple', label: t('automations.builder.mode_simple', 'Simple') },
                        { value: 'advanced', label: t('automations.builder.mode_all_options', 'All options') },
                    ]}
                />
            </View>
            <StepBasics form={form} step={step} locked={ctx.disabled} nameRef={nameRef} />
            {renderStepEditor({ step, draft: form.draft, set: form.set, setMany: form.setMany, patchStep: form.patchStep, ctx })}
            <Text variant="caption" tone="tertiary">
                {t('automations.builder.autosave_note', 'Changes save automatically.')}
            </Text>
        </ScrollView>
    );
}

const makeStyles = (theme: Theme) => ({
    body: { padding: theme.spacing.lg, gap: theme.spacing.lg, paddingBottom: theme.spacing.xxxl } satisfies ViewStyle,
    mode: { alignSelf: 'stretch' } satisfies ViewStyle,
});
