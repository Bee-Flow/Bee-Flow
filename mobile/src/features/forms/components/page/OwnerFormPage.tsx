/**
 * The owner's Form page: Questions · Share · Answers · Settings under the
 * form's header. The automation is open in the flow editor's draft store for as
 * long as the page is (useQuestionsDraft), so a rename, the questions and
 * "collect answers" all save through it.
 *
 * Unsaved questions are asked about before they can be lost — on a tab
 * switch here, and on leaving the screen.
 */

import React, { useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useQuestionsDraft } from '@/features/forms/hooks/useQuestionsDraft';
import { initialTab, TABS_OWNER, type FormTab } from '@/features/forms/model/formPage';
import type { FormDetail } from '@/features/forms/model/types';
import { ConfirmSheet, Screen, type TabBarItem } from '@/shared/ui';

import { FormPageHeader } from './FormPageHeader';
import { RenameFormSheet } from './RenameFormSheet';
import { useLeaveGuard } from './useLeaveGuard';
import { AnswersTab } from '../answers/AnswersTab';
import { QuestionsTab } from '../questions/QuestionsTab';
import { SettingsTab } from '../settings/SettingsTab';
import { ShareTab } from '../share/ShareTab';

export function useFormTabs(tabs: readonly FormTab[], answersCount: number | null | undefined): TabBarItem<FormTab>[] {
    const t = useTranslation();
    const all: Record<FormTab, TabBarItem<FormTab>> = {
        questions: { id: 'questions', label: t('forms.page.tab_questions', 'Questions'), icon: 'ListChecks' },
        share: { id: 'share', label: t('forms.page.tab_share', 'Share'), icon: 'Share2' },
        answers: { id: 'answers', label: t('forms.page.tab_answers', 'Answers'), icon: 'BarChart3', count: typeof answersCount === 'number' ? answersCount : null },
        settings: { id: 'settings', label: t('forms.page.tab_settings', 'Settings'), icon: 'Settings2' },
    };
    return tabs.map((id) => all[id]);
}

export function OwnerFormPage({ form, asked }: { form: FormDetail; asked?: string | null }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const questions = useQuestionsDraft(form.automationId);
    const [tab, setTab] = useState<FormTab>(() => initialTab(true, asked));
    const [pendingTab, setPendingTab] = useState<FormTab | null>(null);
    const [renaming, setRenaming] = useState(false);
    const leave = useLeaveGuard(questions.dirty);
    const tabs = useFormTabs(TABS_OWNER, form.answers?.rowCount);
    const switchTab = (next: FormTab) => {
        if (next === tab) return;
        if (questions.dirty) setPendingTab(next);
        else setTab(next);
    };
    const asking = pendingTab !== null || leave.asking;
    return (
        <Screen edges={['top', 'bottom']} avoidKeyboard>
            <FormPageHeader form={form} tabs={tabs} tab={tab} onTab={switchTab} onRename={() => setRenaming(true)} onShare={() => switchTab('share')} />
            <View style={styles.body}>
                {tab === 'questions' ? <QuestionsTab detail={form} questions={questions} /> : null}
                {tab === 'share' ? <ShareTab form={form} /> : null}
                {tab === 'answers' ? <AnswersTab form={form} /> : null}
                {tab === 'settings' ? <SettingsTab form={form} questions={questions} /> : null}
            </View>
            <RenameFormSheet
                visible={renaming}
                title={form.title}
                locked={questions.locked}
                error={questions.saveError}
                onClose={() => setRenaming(false)}
                onRename={(title) => questions.patchSaved({ title })}
            />
            <ConfirmSheet
                visible={asking}
                title={t('forms.page.unsaved_title', 'Unsaved changes')}
                message={t('forms.page.unsaved_body', 'The questions were changed and not saved. Leave and lose them?')}
                confirmLabel={t('forms.page.unsaved_leave', 'Leave')}
                onConfirm={() => {
                    questions.discard();
                    if (pendingTab) setTab(pendingTab);
                    setPendingTab(null);
                    if (leave.asking) leave.leave();
                }}
                onCancel={() => {
                    setPendingTab(null);
                    leave.stay();
                }}
            />
        </Screen>
    );
}

const makeStyles = (theme: Theme) => ({
    body: { flex: 1, backgroundColor: theme.colors.bgPrimary } satisfies ViewStyle,
});
