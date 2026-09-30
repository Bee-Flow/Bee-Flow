/**
 * One "always hide" term: its name, what to look for, exact text or a
 * pattern, and case. A pattern is compiled the way the server compiles it and
 * the engine's own message is shown; the server's refusal from the last save
 * (termErrors) is shown too, so a pattern that is not in force says so.
 */

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Segmented, Text, TextField, ToggleRow } from '@/shared/ui';

import { labelTaken, validateTerm, type TermProblem } from '../model/terms';
import type { CustomTerm } from '../model/types';

function problemText(problem: TermProblem, t: ReturnType<typeof useTranslation>): string {
    if (problem.kind === 'missing_pattern') return t('mobile.orgShield.term_missing_pattern', 'Fill in what to look for.');
    if (problem.kind === 'too_long') return t('mobile.orgShield.term_too_long', 'Too long — keep it under 500 characters.');
    return problem.message;
}

export function TermEditor({
    term,
    terms,
    serverError,
    onSave,
    onDelete,
    onCancel,
}: {
    term: CustomTerm;
    terms: readonly CustomTerm[];
    serverError: string | null;
    onSave: (next: CustomTerm) => void;
    onDelete: (id: string) => void;
    onCancel: () => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [draft, setDraft] = useState<CustomTerm>(term);
    const problem = validateTerm(draft);
    const duplicate = draft.label.trim() !== '' && labelTaken(terms, draft.label, term.id);
    const labelError = !draft.label.trim()
        ? t('mobile.orgShield.term_missing_label', 'Give it a name.')
        : duplicate
            ? t('mobile.orgShield.terms_err_duplicate', 'A term with that name already exists.')
            : null;
    const patch = (changes: Partial<CustomTerm>) => setDraft((prev) => ({ ...prev, ...changes }));
    return (
        <View style={styles.body}>
            <TextField label={t('common.name', 'Name')} value={draft.label} onChangeText={(label) => patch({ label })} error={labelError} maxLength={120} testID="term-label" />
            <TextField
                label={t('mobile.orgShield.terms_pattern', 'What to look for')}
                value={draft.pattern}
                onChangeText={(pattern) => patch({ pattern })}
                error={problem ? problemText(problem, t) : null}
                autoCapitalize="none"
                autoCorrect={false}
                testID="term-pattern"
            />
            <Segmented
                accessibilityLabel={t('mobile.orgShield.terms_type', 'How to match')}
                value={draft.type}
                onChange={(type) => patch({ type })}
                options={[
                    { value: 'literal', label: t('mobile.orgShield.terms_type_literal', 'Exact text') },
                    { value: 'regex', label: t('mobile.orgShield.terms_type_regex', 'Pattern (advanced)') },
                ]}
                fullWidth
            />
            <ToggleRow label={t('mobile.orgShield.terms_case', 'Case sensitive')} value={draft.caseSensitive} onValueChange={(caseSensitive) => patch({ caseSensitive })} gutter={false} />
            {serverError ? (
                <Text variant="caption" tone="error">
                    {t('mobile.orgShield.terms_err_server', 'Not saved — {error}', { error: serverError })}
                </Text>
            ) : null}
            <Button label={t('mobile.orgShield.term_apply', 'Keep this term')} onPress={() => onSave({ ...draft, label: draft.label.trim() })} disabled={Boolean(problem || labelError)} fullWidth testID="term-apply" />
            <Button label={t('common.delete', 'Delete')} variant="danger" onPress={() => onDelete(term.id)} fullWidth testID="term-delete" />
            <Button label={t('common.back', 'Back')} variant="ghost" onPress={onCancel} fullWidth />
        </View>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        body: { gap: theme.spacing.md },
    });
