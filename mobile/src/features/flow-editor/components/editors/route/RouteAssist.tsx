/**
 * "Suggest outputs" — describe the outputs in words, read them back as
 * sentences, and only then accept them (the web's RouteAssist.jsx). A
 * Condition's rules are a restricted grammar, and "split these files by pdf,
 * word and powerpoint" is five `ends with` comparisons over three outputs; an
 * author who picks "equals" and types `.pdf` gets an output that matches
 * nothing, silently. This box answers the common cases offline
 * (formState/routeIntents), counts each rule against the sample rows the
 * editor already has with the server's own engine, and changes nothing until
 * the author accepts — which pre-fills the outputs chooser above through the
 * same route model as a hand-made edit.
 *
 * The web's model fallback ("Ask the AI instead") and its upstream-step
 * handoff are not on the phone yet; a sentence the catalogue cannot read is
 * answered with what it does understand.
 */

import React, { useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { matchCounts, suggestOutputs } from '@/features/flow-editor/formState';
import type { RouteRule } from '@/features/flow-editor/model';
import { Icon, Text, TextField } from '@/shared/ui';

import { losingWires } from './assistModel';
import type { FieldOption } from './fieldOptions';
import { SuggestionPreview } from './SuggestionPreview';
import { Note } from '../shared/Note';
import { Warn } from '../shared/Warn';

export interface RouteAssistProps {
    /** The fields the rule rows offer: a suggestion only uses one the author could pick by hand. */
    fields: readonly FieldOption[];
    sampleRows: unknown[] | null;
    sampleRoot: unknown;
    /** 'items' for a list-mode node, 'records' for one deciding about the run. */
    unit: 'items' | 'records';
    existing: number;
    wiredNames: readonly string[];
    onApply: (rules: RouteRule[]) => void;
    disabled: boolean;
}

export function RouteAssist({ fields, sampleRows, sampleRoot, unit, existing, wiredNames, onApply, disabled }: RouteAssistProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [text, setText] = useState('');
    const suggestion = suggestOutputs(text, { fields: fields.map((f) => ({ path: f.path, label: f.label, sample: f.sample })) });
    const rules = suggestion.rules;
    const counts = matchCounts(rules, sampleRows, { root: sampleRoot, itemVar: 'item' });
    const unitWord = unit === 'items' ? t('mobile.flow.route.assist.items', 'items') : t('mobile.flow.route.assist.records', 'records');
    return (
        <View style={styles.card} testID="route-assist">
            <View style={styles.title}>
                <Icon name="Lightbulb" size={14} color={styles.glyph.color} />
                <Text variant="caption" weight="medium">
                    {t('mobile.flow.route.assist.title', 'Suggest outputs')}
                </Text>
            </View>
            <Note>{t('mobile.flow.route.assist.intro', 'Describe the outputs in your own words and check them below. Nothing changes until you accept.')}</Note>
            <TextField
                value={text}
                onChangeText={setText}
                placeholder={t('mobile.flow.route.assist.placeholder', 'split these files by pdf, word and powerpoint')}
                accessibilityLabel={t('mobile.flow.route.assist.describe', 'Describe the outputs you want')}
                editable={!disabled}
                autoCapitalize="none"
                testID="route-assist-input"
            />
            {!rules.length && suggestion.problem ? <Warn>{suggestion.problem}</Warn> : null}
            {rules.length ? (
                <SuggestionPreview
                    suggestion={suggestion}
                    counts={counts}
                    unit={unitWord}
                    existing={existing}
                    losing={losingWires(wiredNames, rules)}
                    onApply={() => {
                        onApply(rules.map((r) => ({ name: r.name, expr: r.expr, value: '' })));
                        setText('');
                    }}
                    onReset={() => setText('')}
                    disabled={disabled}
                />
            ) : null}
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    card: {
        gap: theme.spacing.sm, padding: theme.spacing.md, borderRadius: theme.radii.md,
        borderWidth: 1, borderColor: theme.colors.borderDefault, backgroundColor: theme.colors.bgSecondary,
    } satisfies ViewStyle,
    title: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing[1.5] } satisfies ViewStyle,
    glyph: { color: theme.colors.textSecondary },
});
