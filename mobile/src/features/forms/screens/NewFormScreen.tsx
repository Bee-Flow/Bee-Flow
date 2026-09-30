/**
 * "New form" — a name and ONE choice: what happens with the answers (the
 * web's NewFormDialog).
 *
 *   Collect answers in a table (recommended): the routine is created WITH
 *   `collect: true` — the server makes the answers table on that same create —
 *   and the Form page opens, where the questions are edited without ever
 *   seeing the routine builder.
 *   Form that starts a routine: a form trigger, then the builder.
 *
 * Nothing is created until "Create form". The optional brief is not sent with
 * the create: it is parked for the new form and its Questions tab drafts from
 * it at once — so a slow or failing model never leaves the person without a
 * form, only without drafted questions.
 */

import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { ScrollView, View, type ViewStyle } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, Button, Card, Divider, OptionRow, Screen, ScreenHeader, Text, TextField } from '@/shared/ui';

import { useCreateForm } from '../hooks/mutations';
import { MAX_BRIEF_CHARS } from '../model/aiDraft';
import { MAX_LABEL_LEN } from '../model/contract';
import { parkSeed } from '../model/seeds';

type Mode = 'collect' | 'routine';

export function NewFormScreen() {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const router = useRouter();
    const [name, setName] = useState('');
    const [mode, setMode] = useState<Mode>('collect');
    const [brief, setBrief] = useState('');
    const create = useCreateForm({
        onSuccess: (id) => {
            if (mode === 'collect') {
                parkSeed(id, brief);
                router.replace(`/forms/${encodeURIComponent(id)}?tab=questions`);
            } else {
                router.replace(`/automations/${encodeURIComponent(id)}/build`);
            }
        },
    });
    const submit = () => create.mutate({ title: name.trim() || t('studio.new.untitled_form', 'Untitled form'), collect: mode === 'collect' });
    return (
        <Screen edges={['top', 'bottom']} avoidKeyboard>
            <ScreenHeader title={t('forms.new.title', 'New form')} />
            <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
                <TextField
                    label={t('forms.new.name_label', 'Name')}
                    value={name}
                    onChangeText={setName}
                    placeholder={t('forms.new.name_placeholder', 'Customer feedback')}
                    maxLength={MAX_LABEL_LEN}
                    autoFocus
                    testID="new-form-name"
                />
                <Text variant="label" tone="secondary">
                    {t('forms.new.mode_legend', 'What happens with the answers?')}
                </Text>
                <Card padded={false}>
                    <OptionRow
                        label={`${t('forms.new.collect_title', 'Collect answers in a table')} · ${t('forms.new.recommended', 'Recommended')}`}
                        description={t(
                            'forms.new.collect_blurb',
                            'A table is created with one column per question and kept in step with the form. Every answer appears there the moment someone submits, and whoever the table is shared with sees them on a dashboard.',
                        )}
                        selected={mode === 'collect'}
                        onPress={() => setMode('collect')}
                        testID="new-form-collect"
                    />
                    <Divider />
                    <OptionRow
                        label={t('forms.new.routine_title', 'Form that starts a routine')}
                        description={t(
                            'forms.new.routine_blurb',
                            'Every submission starts the steps you build in the routine builder — send an e-mail, file a ticket, ask an agent. No table unless you add one.',
                        )}
                        selected={mode === 'routine'}
                        onPress={() => setMode('routine')}
                        testID="new-form-routine"
                    />
                </Card>
                {mode === 'collect' ? (
                    <TextField
                        label={t('forms.new.brief_label', 'Describe it (optional)')}
                        hint={t('forms.new.brief_hint', 'AI drafts the questions from this on the next screen. You review them before anything is saved.')}
                        value={brief}
                        onChangeText={setBrief}
                        placeholder={t('forms.new.brief_placeholder', 'What should the form ask? A sentence is enough — or paste the checklist, e-mail or policy it should be based on.')}
                        multiline
                        maxLength={MAX_BRIEF_CHARS}
                        testID="new-form-brief"
                    />
                ) : null}
                {create.isError ? <Banner tone="error">{describeError(create.error).message || t('forms.new.failed', 'Could not create the form.')}</Banner> : null}
                <View style={styles.actions}>
                    <Button variant="secondary" label={t('forms.new.cancel', 'Cancel')} onPress={() => router.back()} />
                    <Button label={t('forms.new.create', 'Create form')} onPress={submit} loading={create.isPending} testID="new-form-create" />
                </View>
            </ScrollView>
        </Screen>
    );
}

const makeStyles = (theme: Theme) => ({
    content: { padding: theme.spacing.lg, paddingBottom: theme.spacing.xxxl, gap: theme.spacing.lg } satisfies ViewStyle,
    actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: theme.spacing.sm } satisfies ViewStyle,
});
