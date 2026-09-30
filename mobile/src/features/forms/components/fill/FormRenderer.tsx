/**
 * One form page, rendered natively — the web's PublicFormRenderer. Used by the
 * filling screen and by the Questions tab's preview, so what the author sees
 * while editing is the same control a colleague fills in.
 *
 * The page is drawn in the author's own accent and corners (model/formLook).
 * Required and format checks run before the send as a courtesy; the server
 * re-checks every answer and its per-field refusals land under the same
 * questions. `onSubmit` absent is a preview: every control shows, none sends.
 * `onDirtyChange` hears whether the page holds answers leaving would lose.
 */

import React, { useEffect, useState } from 'react';
import { Pressable, View, type TextStyle, type ViewStyle } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { initialValues, validateAnswers } from '@/features/forms/model/contract';
import { hasAnswers } from '@/features/forms/model/fillDraft';
import type { Answer, Answers, FillForm } from '@/features/forms/model/fillTypes';
import { formLook, type FormLook } from '@/features/forms/model/formLook';
import { Markdown } from '@/shared/markdown';
import { Banner, Spinner, Text } from '@/shared/ui';

import { problemsText, serverFieldErrors } from './answerErrors';
import { FillField } from './FillField';
import type { FillActions } from './types';

export interface FormRendererProps {
    form: FillForm;
    /** Resolves when the server took the page; rejects with its refusal. Absent: a preview. */
    onSubmit?: (values: Answers) => Promise<void>;
    actions?: FillActions;
    /** True while this page holds an answer (never in a preview), false once it holds none. */
    onDirtyChange?: (dirty: boolean) => void;
}

/** The author's colours and corners, as styles made once per look — never inline. */
function lookStyles(look: FormLook) {
    return {
        card: { borderRadius: look.radius, gap: look.gap } satisfies ViewStyle,
        button: { backgroundColor: look.primary, borderRadius: look.radius } satisfies ViewStyle,
        buttonText: { color: look.onPrimary } satisfies TextStyle,
    };
}

function SubmitButton({ label, look, busy, disabled, onPress }: { label: string; look: FormLook; busy: boolean; disabled: boolean; onPress: () => void }) {
    const styles = useThemedStyles(makeStyles);
    const own = lookStyles(look);
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: disabled || busy, busy }}
            onPress={onPress}
            disabled={disabled || busy}
            style={({ pressed }) => [styles.button, own.button, pressed ? styles.pressed : null, disabled ? styles.dim : null]}
            testID="fill-submit"
        >
            {busy ? <Spinner /> : null}
            <Text variant="body" weight="semibold" style={own.buttonText}>
                {label}
            </Text>
        </Pressable>
    );
}

export function FormRenderer({ form, onSubmit, actions = {}, onDirtyChange }: FormRendererProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const look = formLook(form.theme);
    const [values, setValues] = useState<Answers>(() => initialValues(form.fields));
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [formError, setFormError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const preview = !onSubmit;
    const dirty = !preview && hasAnswers(form.fields, values);
    useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);

    const set = (name: string, value: Answer) => {
        setValues((prev) => ({ ...prev, [name]: value }));
        setErrors((prev) => (prev[name] ? { ...prev, [name]: '' } : prev));
    };
    const submit = async () => {
        if (!onSubmit || busy) return;
        const found = problemsText(t, validateAnswers(form.fields, values), form.fields);
        setErrors(found);
        if (Object.keys(found).length) return;
        setBusy(true);
        setFormError(null);
        try {
            await onSubmit(values);
        } catch (err) {
            const perField = serverFieldErrors(err);
            if (perField) setErrors(perField);
            else setFormError(describeError(err).message);
        } finally {
            setBusy(false);
        }
    };

    return (
        <View style={[styles.card, lookStyles(look).card]} testID="form-renderer">
            <View style={styles.header}>
                <Text variant="title">{form.title || t('mobile.forms.fill.untitled', 'Form')}</Text>
                {form.description ? <Markdown value={form.description} /> : null}
            </View>
            {form.fields.map((field) => (
                <FillField
                    key={field.name}
                    field={field}
                    value={values[field.name] ?? null}
                    error={errors[field.name] || null}
                    disabled={busy}
                    onChange={(v) => set(field.name, v)}
                    onError={(message) => setErrors((prev) => ({ ...prev, [field.name]: message }))}
                    look={look}
                    actions={actions}
                />
            ))}
            {formError ? <Banner tone="error">{formError}</Banner> : null}
            <SubmitButton
                label={form.submitLabel || t('mobile.forms.fill.submit', 'Submit')}
                look={look}
                busy={busy}
                disabled={preview}
                onPress={() => void submit()}
            />
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    card: {
        padding: theme.spacing.xl,
        borderWidth: 1,
        borderColor: theme.colors.borderDefault,
        backgroundColor: theme.colors.bgCard,
    } satisfies ViewStyle,
    header: { gap: theme.spacing.sm } satisfies ViewStyle,
    button: {
        minHeight: theme.minTouch,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.spacing.sm,
        paddingHorizontal: theme.spacing.lg,
    } satisfies ViewStyle,
    pressed: { opacity: 0.85 } satisfies ViewStyle,
    dim: { opacity: 0.6 } satisfies ViewStyle,
});
