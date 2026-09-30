/**
 * "Build it with AI" — the card above the question editor (the web's
 * AiDraftPanel). A fresh form takes a BRIEF and the whole form is drafted;
 * a form with questions takes a REQUEST, and the current questions travel
 * along so a kept question keeps its name. The draft lands in the UNSAVED
 * editor below — nothing is stored until Save, and Undo puts back exactly
 * what the editor held before.
 *
 * A brief parked by the "New form" screen for this form is put in the box and
 * run once, on arrival.
 */

import React, { useEffect, useRef, useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { FormDeclaration } from '@/features/flow-editor';
import { useDraftFormWithAi } from '@/features/forms/hooks/mutations';
import { draftBody, draftErrorWords, isBlankForm, MAX_BRIEF_CHARS, type DraftMode } from '@/features/forms/model/aiDraft';
import { cloneForm } from '@/features/forms/model/questionsDraft';
import { Button, Card, Icon, Segmented, Text, TextField } from '@/shared/ui';

interface Result {
    count: number;
    notes: string | null;
    before: FormDeclaration | null;
}

function errorText(t: TranslateFn, err: unknown): string {
    const words = draftErrorWords(err);
    return words ? t(words.key, words.fallback) : describeError(err).message;
}

function doneText(t: TranslateFn, result: Result): string {
    const done =
        result.count === 1
            ? t('forms.ai.done', '{count} question drafted — review it below, then Save.', { count: result.count })
            : t('forms.ai.done_plural', '{count} questions drafted — review them below, then Save.', { count: result.count });
    return result.notes ? `${done} ${result.notes}` : done;
}

/** The card's state and its one call: draft, apply to the editor, remember what was there for Undo. */
function useAiDraft(form: FormDeclaration, onApply: (next: FormDeclaration) => void, seed: string | null) {
    const t = useTranslation();
    const blank = isBlankForm(form);
    const [text, setText] = useState(seed ?? '');
    const [mode, setMode] = useState<DraftMode>(blank ? 'create' : 'revise');
    const [error, setError] = useState<string | null>(null);
    const [result, setResult] = useState<Result | null>(null);
    const draft = useDraftFormWithAi();
    const effective: DraftMode = blank ? 'create' : mode;
    const run = async (input?: string) => {
        const value = (input ?? text).trim();
        if (!value || draft.isPending) return;
        setError(null);
        try {
            const res = await draft.mutateAsync(draftBody(effective, value, form));
            const before = cloneForm(form);
            onApply(res.form as FormDeclaration);
            setResult({ count: res.form.fields.length, notes: res.notes, before });
            setMode('revise');
            setText('');
        } catch (err) {
            setError(errorText(t, err));
        }
    };
    const seeded = useRef(false);
    useEffect(() => {
        if (seeded.current || !seed) return;
        seeded.current = true;
        void run(seed);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- a parked brief runs once, on arrival
    }, [seed]);
    const undo = () => {
        if (!result?.before) return;
        onApply(result.before);
        setMode(isBlankForm(result.before) ? 'create' : 'revise');
        setResult(null);
    };
    const chooseMode = (next: DraftMode) => {
        setMode(next);
        setError(null);
    };
    return { blank, text, setText, mode, chooseMode, revise: effective === 'revise', error, result, busy: draft.isPending, run, undo };
}

type AiDraft = ReturnType<typeof useAiDraft>;

function Intro({ revise }: { revise: boolean }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <>
            <View style={styles.head}>
                <Icon name="Sparkles" size={16} color={styles.accent.color} />
                <Text variant="subheading">{t('forms.ai.title', 'Build it with AI')}</Text>
            </View>
            <Text variant="caption" tone="secondary">
                {revise
                    ? t('forms.ai.intro_revise', 'Say what should change. The questions you keep stay as they are — and so do their answers.')
                    : t(
                          'forms.ai.intro',
                          'Describe the form, or paste what it should be based on — an intake checklist, an e-mail, a policy. The questions are drafted below for you to review; nothing is saved until you save.',
                      )}
            </Text>
        </>
    );
}

function Box({ ai, disabled }: { ai: AiDraft; disabled: boolean }) {
    const t = useTranslation();
    const placeholder = ai.revise
        ? t('forms.ai.placeholder_revise', 'e.g. add a phone number, make the address optional, shorter labels')
        : t('forms.ai.placeholder', 'e.g. A vacation request: name, department, first and last day, a reason, and whether a colleague covers. Or paste the checklist the form should follow.');
    return (
        <TextField
            value={ai.text}
            onChangeText={ai.setText}
            multiline
            maxLines={ai.revise ? 3 : 6}
            maxLength={MAX_BRIEF_CHARS}
            editable={!ai.busy && !disabled}
            placeholder={placeholder}
            accessibilityLabel={t('forms.ai.title', 'Build it with AI')}
            testID="form-ai-text"
        />
    );
}

function Outcome({ ai }: { ai: AiDraft }) {
    const t = useTranslation();
    if (ai.error) {
        return (
            <Text variant="caption" tone="error">
                {ai.error}
            </Text>
        );
    }
    if (!ai.result) return null;
    return (
        <Text variant="caption" tone="success" testID="form-ai-done">
            {doneText(t, ai.result)}
        </Text>
    );
}

function Actions({ ai, disabled }: { ai: AiDraft; disabled: boolean }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const idle = ai.revise ? t('forms.ai.run_revise', 'Change the questions') : t('forms.ai.run', 'Draft the questions');
    return (
        <View style={styles.actions}>
            {ai.result?.before ? <Button size="sm" variant="secondary" iconName="Undo2" label={t('forms.ai.undo', 'Undo')} onPress={ai.undo} disabled={ai.busy} /> : null}
            <Button
                size="sm"
                iconName="Sparkles"
                loading={ai.busy}
                label={ai.busy ? t('forms.ai.running', 'Drafting…') : idle}
                onPress={() => void ai.run()}
                disabled={!ai.text.trim() || disabled}
                testID="form-ai-run"
            />
        </View>
    );
}

export function AiDraftCard({ form, onApply, seed, disabled = false }: { form: FormDeclaration; onApply: (next: FormDeclaration) => void; seed: string | null; disabled?: boolean }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const ai = useAiDraft(form, onApply, seed);
    return (
        <Card>
            <View style={styles.body} testID="form-ai">
                <Intro revise={ai.revise} />
                {!ai.blank ? (
                    <Segmented
                        value={ai.mode}
                        onChange={ai.chooseMode}
                        options={[
                            { value: 'revise', label: t('forms.ai.mode_revise', 'Change the current questions') },
                            { value: 'create', label: t('forms.ai.mode_create', 'Start over from a description') },
                        ]}
                        accessibilityLabel={t('forms.ai.mode_label', 'What the AI does')}
                    />
                ) : null}
                <Box ai={ai} disabled={disabled} />
                <Outcome ai={ai} />
                <Actions ai={ai} disabled={disabled} />
            </View>
        </Card>
    );
}

const makeStyles = (theme: Theme) => ({
    body: { gap: theme.spacing.sm } satisfies ViewStyle,
    head: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm } satisfies ViewStyle,
    actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: theme.spacing.sm } satisfies ViewStyle,
    accent: { color: theme.colors.accentPrimary },
});
