/**
 * Fill a form in, natively — the web's /app/forms/<token> (PublicFormPage).
 *
 * Reached from a form's link, the drawer's Forms rows and a colleague's form
 * in the list. The route carries the page TOKEN because that is what a link
 * is; it goes to the form calls and nowhere else. A journey in progress is
 * mirrored into `?s=` so the screen, reopened on the same route, picks the
 * journey up instead of starting it again at page one.
 *
 * Answers on the page being filled in are held only here until it is sent,
 * so leaving (Back, a swipe) with any typed asks first.
 */

import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { ScrollView, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useConfirmLeave } from '@/shared/patterns';
import { LoadingState, Screen, ScreenHeader } from '@/shared/ui';

import { FillMessage } from '../components/fill/FillMessage';
import { FormEnding } from '../components/fill/FormEnding';
import { FormRenderer } from '../components/fill/FormRenderer';
import { FormWaiting } from '../components/fill/FormWaiting';
import type { FillActions } from '../components/fill/types';
import { useFormFill, type FormFill } from '../hooks/useFormFill';

export interface FillFormScreenProps {
    token: string;
    /** A session to resume, from `?s=`. */
    resume?: string | null;
}

function useActions(fill: FormFill): FillActions & { saveToNotebook: () => Promise<void> } {
    const router = useRouter();
    const openNotebook = (id: string | null) => {
        if (id) router.push(`/notebooks/${encodeURIComponent(id)}`);
    };
    return {
        upload: fill.upload,
        searchApp: fill.searchApp,
        shareFile: fill.shareFile,
        openInNotebooks: async (field) => openNotebook(await fill.openInNotebooks(field)),
        saveToNotebook: async () => openNotebook(await fill.saveToNotebook()),
    };
}

function FillBody({ fill, onDirtyChange }: { fill: FormFill; onDirtyChange: (dirty: boolean) => void }) {
    const t = useTranslation();
    const actions = useActions(fill);
    const { state } = fill;
    switch (state.status) {
        case 'loading':
            return <LoadingState label={t('mobile.forms.fill.loading', 'Opening the form…')} />;
        case 'form':
            return state.form ? (
                <FormRenderer
                    key={state.page}
                    form={state.form}
                    onSubmit={(values) => fill.submit(state.form?.fields ?? [], values)}
                    actions={actions}
                    onDirtyChange={onDirtyChange}
                />
            ) : null;
        case 'working':
            return <FormWaiting progress={state.progress} note={state.progressNote} />;
        case 'done':
            return <FormEnding form={state.ending} actions={actions} onSaveToNotebook={state.fileSessionId ? actions.saveToNotebook : undefined} />;
        case 'slow':
            return <FillMessage status="slow" onRetry={fill.checkAgain} />;
        default:
            return <FillMessage status={state.status} />;
    }
}

export function FillFormScreen({ token, resume = null }: FillFormScreenProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const router = useRouter();
    const fill = useFormFill(token, resume);
    const [answered, setAnswered] = useState(false);
    useConfirmLeave(answered && fill.state.status === 'form');
    const { sessionId } = fill.state;
    useEffect(() => {
        router.setParams({ s: sessionId ?? undefined });
    }, [router, sessionId]);
    const title = fill.state.form?.title || fill.state.ending?.title || t('sidebar.forms', 'Forms');
    return (
        <Screen edges={['top', 'bottom']} avoidKeyboard>
            <ScreenHeader title={title} />
            <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
                <FillBody fill={fill} onDirtyChange={setAnswered} />
            </ScrollView>
        </Screen>
    );
}

const makeStyles = (theme: Theme) => ({
    content: { padding: theme.spacing.lg, paddingBottom: theme.spacing.xxxl, gap: theme.spacing.lg } satisfies ViewStyle,
});
