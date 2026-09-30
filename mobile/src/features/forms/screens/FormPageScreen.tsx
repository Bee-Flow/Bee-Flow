/**
 * One form's page — Studio → Forms → a form (the web's FormPage).
 *
 * Addressed by the ROUTINE's id: the page token is the form's whole
 * credential and never travels in a route. An older link that still carries
 * a token (/forms/<token>) is resolved to its routine through the forms list
 * and the route swapped for one that does not carry it.
 *
 * The owner gets Questions · Share · Answers · Settings; a colleague the
 * answers table is shared with gets Answers; anyone else who may fill the
 * form in is sent to filling it in.
 */

import { useRouter } from 'expo-router';
import React, { useEffect } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { EmptyState, ErrorState, LoadingState, Screen, ScreenHeader } from '@/shared/ui';

import { AnswersTab } from '../components/answers/AnswersTab';
import { FormPageHeader } from '../components/page/FormPageHeader';
import { OwnerFormPage, useFormTabs } from '../components/page/OwnerFormPage';
import { useFormDetail, useResolvedFormRef } from '../hooks/queries';
import { canOpenForm, TABS_VIEWER } from '../model/formPage';
import type { FormDetail } from '../model/types';

export interface FormPageScreenProps {
    /** The routine's id — or, from an older link, the form's page token. */
    formRef: string;
    /** The tab to open on (`?tab=`), when the caller may see it. */
    tab?: string | null;
}

function Frame({ children }: { children: React.ReactNode }) {
    const t = useTranslation();
    return (
        <Screen edges={['top', 'bottom']}>
            <ScreenHeader title={t('sidebar.forms', 'Forms')} />
            {children}
        </Screen>
    );
}

function ViewerFormPage({ form }: { form: FormDetail }) {
    const styles = useThemedStyles(makeStyles);
    const tabs = useFormTabs(TABS_VIEWER, form.answers?.rowCount);
    return (
        <Screen edges={['top', 'bottom']}>
            <FormPageHeader form={form} tabs={tabs} tab="answers" onTab={() => undefined} onShare={() => undefined} />
            <View style={styles.body}>
                <AnswersTab form={form} />
            </View>
        </Screen>
    );
}

function FormPage({ automationId, tab }: { automationId: string; tab?: string | null }) {
    const t = useTranslation();
    const router = useRouter();
    const detail = useFormDetail(automationId);
    const form = detail.data ?? null;
    const sendToFill = !!form && !form.mine && !canOpenForm(form) && form.canOpen && !!form.id;
    useEffect(() => {
        if (sendToFill && form) router.replace(`/forms/fill/${encodeURIComponent(form.id)}`);
    }, [sendToFill, form, router]);
    if (detail.isLoading) return <Frame><LoadingState label={t('forms.page.loading', 'Loading the form…')} /></Frame>;
    if (detail.isError) return <Frame><ErrorState error={detail.error} onRetry={() => void detail.refetch()} /></Frame>;
    if (!form || (!canOpenForm(form) && !sendToFill)) {
        return (
            <Frame>
                <EmptyState icon="Lock" title={t('forms.page.not_found', 'This form is not available to this account.')} />
            </Frame>
        );
    }
    if (sendToFill) return <Frame><LoadingState /></Frame>;
    return form.mine ? <OwnerFormPage form={form} asked={tab} /> : <ViewerFormPage form={form} />;
}

export function FormPageScreen({ formRef, tab = null }: FormPageScreenProps) {
    const router = useRouter();
    const ref = useResolvedFormRef(formRef);
    const redirect = ref.resolved?.redirect ? ref.resolved.automationId : null;
    useEffect(() => {
        if (redirect) router.replace(`/forms/${encodeURIComponent(redirect)}`);
    }, [redirect, router]);
    if (ref.isError) return <Frame><ErrorState error={ref.error} onRetry={() => void ref.refetch()} /></Frame>;
    if (!ref.resolved || redirect) return <Frame><LoadingState /></Frame>;
    return <FormPage automationId={ref.resolved.automationId} tab={tab} />;
}

const makeStyles = (theme: Theme) => ({
    body: { flex: 1, backgroundColor: theme.colors.bgPrimary } satisfies ViewStyle,
});
