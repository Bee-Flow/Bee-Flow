/**
 * A form page's styling — presets and five knobs (the theme half of the
 * web's FormStyleEditor, flow/settings/formStyle/; the knobs are the
 * platform's shared THEME_SPEC). The web's form-only style knobs and custom
 * CSS are not on the phone. A later page matches the first one by default,
 * so a form does not change its look halfway through; overriding is one
 * switch.
 */

import React from 'react';
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { ToggleField } from '@/features/flow-editor/components/fields';
import { THEME_PRESETS, themePresetLabel, type FormTheme } from '@/features/flow-editor/model';
import { Chip, Segmented, Text } from '@/shared/ui';

import { activePreset, COLOR_PRESETS, THEME_KNOBS } from './formModel';
import { say } from '../declarative/runtime';

/** One style per fixed colour, made once — a colour is data here, never an inline style. */
const SWATCH = StyleSheet.create(Object.fromEntries(COLOR_PRESETS.map((hex) => [hex, { backgroundColor: hex }])));
const DOT = StyleSheet.create(Object.fromEntries(THEME_PRESETS.map((p) => [p.id, { backgroundColor: p.theme.primary }])));

export interface ThemeEditorProps {
    theme: FormTheme;
    inherits: boolean;
    canInherit: boolean;
    onChange: (next: FormTheme | null) => void;
    disabled?: boolean;
}

function Swatches({ theme, onChange }: { theme: FormTheme; onChange: (next: FormTheme) => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const name = t('forms.style.primary', 'Main colour');
    return (
        <View style={styles.swatches}>
            {COLOR_PRESETS.map((hex) => (
                <Pressable
                    key={hex}
                    onPress={() => onChange({ ...theme, primary: hex })}
                    accessibilityRole="button"
                    accessibilityState={{ selected: theme.primary === hex }}
                    accessibilityLabel={t('forms.style.swatch', '{name}: {hex}', { name, hex })}
                    style={[styles.swatch, SWATCH[hex], theme.primary === hex ? styles.swatchOn : null]}
                />
            ))}
        </View>
    );
}

export function ThemeEditor({ theme, inherits, canInherit, onChange, disabled = false }: ThemeEditorProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const active = activePreset(THEME_PRESETS, theme);
    return (
        <View style={styles.box}>
            <Text variant="label" tone="tertiary">
                {t('forms.style.heading', 'Design')}
            </Text>
            {canInherit ? (
                <ToggleField
                    value={inherits}
                    onChange={(on) => onChange(on ? null : { ...theme })}
                    label={t('automations.form_builder_fields.match_the_first_page', 'Match the first page')}
                    disabled={disabled}
                />
            ) : null}
            {canInherit && inherits ? null : (
                <>
                    <View style={styles.swatches}>
                        {THEME_PRESETS.map((p) => (
                            <Chip
                                key={p.id}
                                label={themePresetLabel(p, t)}
                                selected={active?.id === p.id}
                                onPress={() => onChange({ ...p.theme })}
                                icon={<View style={[styles.dot, DOT[p.id]]} />}
                                disabled={disabled}
                            />
                        ))}
                    </View>
                    <Text variant="label" tone="tertiary">
                        {t('forms.style.primary', 'Main colour')}
                    </Text>
                    <Swatches theme={theme} onChange={onChange} />
                    {THEME_KNOBS.map((knob) => (
                        <View key={knob.key} style={styles.knob}>
                            <Text variant="label" tone="tertiary">
                                {say(t, knob.label)}
                            </Text>
                            <Segmented
                                value={String(theme[knob.key] ?? '')}
                                onChange={(v) => onChange({ ...theme, [knob.key]: v })}
                                options={knob.values.map((v) => ({ value: v, label: v }))}
                                accessibilityLabel={say(t, knob.label)}
                                fullWidth
                            />
                        </View>
                    ))}
                </>
            )}
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    box: { gap: theme.spacing.sm } satisfies ViewStyle,
    swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm } satisfies ViewStyle,
    swatch: { width: 32, height: 32, borderRadius: theme.radii.pill } satisfies ViewStyle,
    swatchOn: { borderWidth: 3, borderColor: theme.colors.textPrimary } satisfies ViewStyle,
    dot: { width: 12, height: 12, borderRadius: theme.radii.pill } satisfies ViewStyle,
    knob: { gap: theme.spacing.xs } satisfies ViewStyle,
});
