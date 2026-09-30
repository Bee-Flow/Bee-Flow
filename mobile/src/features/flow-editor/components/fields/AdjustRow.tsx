/**
 * "Adjust the value" under a field that holds ONE picked value — the web value
 * builder's transform row (agent-hub `Builder/mapping/ValueBuilder.jsx`, the
 * select under a single chip, and its TransformArg): lowercase, just the first
 * one, joined into text, as a written date… and the one choice some of them
 * take (a separator, a notation, a number style, two words for yes and no).
 *
 * It used to be reachable only as a formula: a value the web or the AI builder
 * had adjusted (`formatDate(steps.x.output.date, "DD-MM-YYYY")`) opened in
 * Formula mode with Text greyed out.
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import {
    DATE_FORMATS,
    NUMBER_STYLES,
    TRANSFORM_BY_ID,
    VALUE_TRANSFORMS,
    numberStyleLabel,
    transformHint,
    transformLabel,
} from '@/features/flow-editor/bindings';
import { TextField } from '@/shared/ui';

import type { Adjustment } from './bindingText';
import { SelectField, type SelectOption } from './SelectField';

/** The separators the web's join chooser offers, in its order. */
const SEPARATORS: readonly { value: string; key: string; en: string }[] = [
    { value: ', ', key: 'routines.builder.sep_comma_space', en: 'a comma and a space' },
    { value: ',', key: 'routines.builder.sep_comma', en: 'a comma' },
    { value: '; ', key: 'routines.builder.sep_semicolon', en: 'a semicolon' },
    { value: ' ', key: 'routines.builder.sep_space', en: 'a space' },
    { value: '\n', key: 'routines.builder.sep_newline', en: 'a new line' },
];

/** A fresh adjustment starts from ITS OWN default choice, never the previous one's. */
export function adjustmentFor(id: string): Adjustment | null {
    const spec = TRANSFORM_BY_ID[id];
    return spec ? { transform: id, arg: spec.argDefault ?? null, arg2: spec.arg2Default ?? null } : null;
}

function ArgField({ adjust, onChange, disabled }: { adjust: Adjustment; onChange: (next: Adjustment) => void; disabled?: boolean }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const set = (arg: string | null, arg2: string | null = adjust.arg2) => onChange({ ...adjust, arg, arg2 });
    const pick = (label: string, value: string, options: SelectOption[]) => (
        <SelectField label={label} value={value} options={options} onChange={(v) => set(v)} disabled={disabled} testID="adjust-arg" />
    );
    switch (adjust.transform) {
        case 'join':
            return pick(t('routines.builder.separated_by', 'Separated by'), adjust.arg ?? ', ', SEPARATORS.map((s) => ({ value: s.value, label: t(s.key, s.en) })));
        case 'formatNumber':
            return pick(t('routines.builder.number_style', 'Shown as'), adjust.arg ?? 'amount', NUMBER_STYLES.map((s) => ({ value: s.value, label: numberStyleLabel(s.value) })));
        case 'formatDate':
            return pick(t('routines.builder.date_notation', 'Written as'), adjust.arg ?? DATE_FORMATS[0]?.value ?? '', DATE_FORMATS.map((f) => ({ value: f.value, label: f.example })));
        case 'yesNoText':
            return (
                <View style={styles.words}>
                    <TextField
                        label={t('routines.builder.yes_says', 'Yes says')}
                        value={adjust.arg ?? 'yes'}
                        onChangeText={(v) => set(v, adjust.arg2 ?? 'no')}
                        editable={!disabled}
                        containerStyle={styles.word}
                    />
                    <TextField
                        label={t('routines.builder.no_says', 'no says')}
                        value={adjust.arg2 ?? 'no'}
                        onChangeText={(v) => set(adjust.arg ?? 'yes', v)}
                        editable={!disabled}
                        containerStyle={styles.word}
                    />
                </View>
            );
        default:
            return null;
    }
}

export function AdjustRow({ adjust, onChange, disabled }: { adjust: Adjustment | null; onChange: (next: Adjustment | null) => void; disabled?: boolean }) {
    const t = useTranslation();
    const options: SelectOption[] = [
        { value: '', label: t('routines.builder.use_as_is', 'use it as it is') },
        ...VALUE_TRANSFORMS.map((tr) => ({ value: tr.id, label: transformLabel(tr.id), description: transformHint(tr.id) })),
    ];
    return (
        <>
            <SelectField
                label={t('routines.builder.adjust_aria', 'Adjust the value')}
                value={adjust?.transform ?? ''}
                options={options}
                onChange={(id) => onChange(id ? adjustmentFor(id) : null)}
                disabled={disabled}
                testID="adjust"
            />
            {adjust ? <ArgField adjust={adjust} onChange={onChange} disabled={disabled} /> : null}
        </>
    );
}

const makeStyles = (theme: Theme) => ({
    words: { flexDirection: 'row', gap: theme.spacing.sm } satisfies ViewStyle,
    word: { flex: 1 } satisfies ViewStyle,
});
