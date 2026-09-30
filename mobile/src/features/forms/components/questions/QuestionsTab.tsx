/**
 * Questions — the trigger's form, editable without the routine builder (the
 * web's QuestionsTab): "Build it with AI" above the builder's own page editor
 * (title, intro, questions, button text, thank-you, styling), a preview of the
 * page as it will be filled in, and Save / Discard under it. Pages after page
 * one stay in the routine; a note says how many and opens it.
 */

import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { ScrollView, View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { FormPageEditor, useFormPickSources } from '@/features/flow-editor';
import type { QuestionsDraft } from '@/features/forms/hooks/useQuestionsDraft';
import { previewForm } from '@/features/forms/model/preview';
import { takeSeed } from '@/features/forms/model/seeds';
import type { FormDetail } from '@/features/forms/model/types';
import { Banner, Button, ErrorState, LoadingState, Sheet } from '@/shared/ui';

import { AiDraftCard } from './AiDraftCard';
import { SaveBar } from './SaveBar';
import { FormRenderer } from '../fill/FormRenderer';

function PagesNote({ detail }: { detail: FormDetail }) {
    const t = useTranslation();
    const router = useRouter();
    const count = detail.pages.length;
    if (!count) return null;
    return (
        <Banner
            tone="info"
            icon="Info"
            action={<Button size="sm" variant="ghost" label={t('forms.studio.open_routine', 'Open the routine')} onPress={() => router.push(`/automations/${detail.automationId}/build`)} />}
        >
            {count === 1
                ? t('forms.page.pages_note', '{count} more page — edit it in the routine', { count })
                : t('forms.page.pages_note_plural', '{count} more pages — edit them in the routine', { count })}
        </Banner>
    );
}

export function QuestionsTab({ detail, questions }: { detail: FormDetail; questions: QuestionsDraft }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const pickSources = useFormPickSources().data ?? [];
    const [seed] = useState(() => takeSeed(detail.automationId));
    const [previewing, setPreviewing] = useState(false);
    const { draft } = questions;
    if (questions.loadError && !draft) return <ErrorState error={questions.loadError} />;
    if (!draft) return <LoadingState label={t('forms.page.loading_editor', 'Loading the editor…')} />;
    return (
        <View style={styles.fill}>
            <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" testID="form-questions">
                <AiDraftCard form={draft} onApply={questions.setDraft} seed={seed} disabled={questions.locked} />
                <PagesNote detail={detail} />
                <FormPageEditor
                    form={draft}
                    onChange={questions.setDraft}
                    bindingBase="trigger.output"
                    pickSources={pickSources}
                    rename={null}
                    disabled={questions.locked || questions.saving}
                />
                <Button variant="secondary" iconName="Eye" label={t('routine_editor.preview', 'Preview')} onPress={() => setPreviewing(true)} />
                {detail.answers?.collecting ? (
                    <Banner tone="info" icon="Info">
                        {t(
                            'forms.page.columns_note',
                            'Every question here is a column in the answers table. Renaming a question renames its column; removing one keeps the column, marked “no longer on the form”.',
                        )}
                    </Banner>
                ) : null}
            </ScrollView>
            <SaveBar
                dirty={questions.dirty}
                locked={questions.locked}
                saving={questions.saving}
                error={questions.saveError}
                onSave={() => void questions.save()}
                onDiscard={questions.discard}
            />
            <Sheet visible={previewing} onClose={() => setPreviewing(false)} title={t('routine_editor.preview', 'Preview')} tall>
                <FormRenderer form={previewForm(draft)} />
            </Sheet>
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    fill: { flex: 1 } satisfies ViewStyle,
    content: { padding: theme.spacing.lg, paddingBottom: theme.spacing.xxxl, gap: theme.spacing.lg } satisfies ViewStyle,
});
