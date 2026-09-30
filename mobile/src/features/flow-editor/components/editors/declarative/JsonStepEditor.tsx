/**
 * The last fallback: a step type with neither a spec nor a bespoke editor
 * shows its settings as JSON (jsonConfig.ts), as the web's JSON view does.
 * Every type the web gives a form has one here too; what is left is what the
 * web has no form for either (`parallel`, engine-only; `parse_json`, retired
 * into Edit data) and a type this build does not know.
 * Edited as text with an explicit Apply — never saved per keystroke, since a
 * half-typed object is not a step — and refused, with the reason, when it is
 * not a plain object or touches a key that is not configuration. Leaving the
 * editor with valid JSON not yet applied applies it.
 */

import React, { useEffect, useRef, useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Section } from '@/features/flow-editor/components/nodeEditor/Section';
import { Banner, Button, TextField } from '@/shared/ui';

import type { StepEditorProps } from '../types';
import { configText, parseConfig, type ConfigParse } from './jsonConfig';

function reasonText(t: ReturnType<typeof useTranslation>, result: Extract<ConfigParse, { ok: false }>): string {
    if (result.reason === 'invalid') return t('routines.ndv.err_invalid_json', 'Invalid JSON: {message}', { message: result.message ?? '' });
    if (result.reason === 'reserved') return t('mobile.flow.json.reserved', '“{key}” is not a setting — it is edited elsewhere.', { key: result.key ?? '' });
    return t('mobile.flow.json.not_object', 'The settings must be one JSON object: { … }.');
}

export function JsonStepEditor({ step, patchStep, ctx }: StepEditorProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const stored = configText(step);
    const [text, setText] = useState(stored);
    const [error, setError] = useState<string | null>(null);
    const [seen, setSeen] = useState(stored);
    if (seen !== stored) {
        setSeen(stored);
        setText(stored);
        setError(null);
    }
    // Leaving with valid, unapplied JSON keeps it (the step editor has no
    // other save to lose it to); invalid text stays unsaved, as before.
    const latest = useRef({ text, stored, step, patchStep });
    useEffect(() => {
        latest.current = { text, stored, step, patchStep };
    });
    useEffect(
        () => () => {
            const last = latest.current;
            if (last.text === last.stored) return;
            const result = parseConfig(last.step, last.text);
            if (result.ok) last.patchStep(result.patch);
        },
        [],
    );
    const apply = () => {
        const result = parseConfig(step, text);
        if (!result.ok) {
            setError(reasonText(t, result));
            return;
        }
        setError(null);
        patchStep(result.patch);
    };
    return (
        <Section stepType={String(step.type)} sectionKey="json" title={t('mobile.flow.json.title', 'Settings (JSON)')} ctx={ctx} defaultOpen>
            {step.type === 'parse_json' ? (
                <Banner tone="info">
                    {t(
                        'mobile.flow.json.parse_json_moved',
                        'This step type has moved into Edit data — this existing step keeps working. For new extractions, add an Edit data step and use “Pick fields from it”.',
                    )}
                </Banner>
            ) : null}
            <Banner tone="info">{t('mobile.flow.json.hint', 'This step’s settings are shown as JSON. Change them with care — they are saved exactly as written.')}</Banner>
            <TextField
                value={text}
                onChangeText={(next) => {
                    setText(next);
                    setError(null);
                }}
                multiline
                maxLines={18}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!ctx.disabled}
                error={error}
                accessibilityLabel={t('mobile.flow.json.title', 'Settings (JSON)')}
                testID="step-json"
            />
            <View style={styles.actions}>
                <Button
                    size="sm"
                    variant="secondary"
                    label={t('routines.builder.undo_changes', 'Undo changes')}
                    disabled={text === stored}
                    onPress={() => {
                        setText(stored);
                        setError(null);
                    }}
                />
                <Button size="sm" label={t('mobile.flow.json.apply', 'Apply')} disabled={text === stored || ctx.disabled} onPress={apply} testID="step-json-apply" />
            </View>
        </Section>
    );
}

const makeStyles = (theme: Theme) => ({
    actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: theme.spacing.sm } satisfies ViewStyle,
});
