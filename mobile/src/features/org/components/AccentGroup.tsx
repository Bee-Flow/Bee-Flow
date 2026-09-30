/**
 * The accent colour (AccentSection.jsx): the web's six presets as swatches,
 * and a hex field for any other colour. Only a value the server accepts —
 * `#` and six hex digits — reaches the form; anything else stays in the field
 * with the reason under it.
 */

import React, { useState } from 'react';
import { Pressable, View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Group, Icon, TextField } from '@/shared/ui';

import { FieldRow } from './FieldRow';
import { ACCENT_PRESETS, isValidAccent, normalizeAccent } from '../model/theme';

const makeStyles = (theme: Theme) => ({
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.md } satisfies ViewStyle,
    swatch: {
        width: 40,
        height: 40,
        borderRadius: 20,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 2,
        borderColor: 'transparent',
    } satisfies ViewStyle,
    chosen: { borderColor: theme.colors.textPrimary } satisfies ViewStyle,
});

function Swatch({ colour, selected, disabled, onPress }: { colour: string; selected: boolean; disabled: boolean; onPress: () => void }) {
    const styles = useThemedStyles(makeStyles);
    const fill = { backgroundColor: colour };
    return (
        <Pressable
            testID={`accent-${colour}`}
            accessibilityRole="radio"
            accessibilityLabel={colour}
            accessibilityState={{ selected, disabled }}
            disabled={disabled}
            onPress={onPress}
            style={selected ? [styles.swatch, fill, styles.chosen] : [styles.swatch, fill]}
        >
            {selected ? <Icon name="Check" size={18} color="#ffffff" /> : null}
        </Pressable>
    );
}

export function AccentGroup({
    value,
    onChange,
    disabled,
}: {
    value: string;
    onChange: (hex: string) => void;
    disabled: boolean;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [typed, setTyped] = useState<string | null>(null);
    const typedValid = typed !== null && isValidAccent(normalizeAccent(typed));
    // A valid typed colour that no longer matches (a swatch, or Discard) gives way to the value.
    const text = typed !== null && (!typedValid || normalizeAccent(typed) === value) ? typed : value;
    const error = typed !== null && !typedValid
        ? t('mobile.org.accent_invalid', 'A colour like #3b82f6: a # and six hex digits.')
        : null;
    return (
        <Group
            title={t('mobile.org.theme_accent', 'Accent colour')}
            footer={t('mobile.org.theme_accent_note', 'Used for primary buttons, selected items, focus rings, and active states.')}
        >
            <FieldRow>
                <View style={styles.grid}>
                    {ACCENT_PRESETS.map((colour) => (
                        <Swatch
                            key={colour}
                            colour={colour}
                            selected={value.toLowerCase() === colour}
                            disabled={disabled}
                            onPress={() => {
                                setTyped(null);
                                onChange(colour);
                            }}
                        />
                    ))}
                </View>
                <TextField
                    testID="accent-hex"
                    label={t('mobile.org.accent_hex', 'Hex colour')}
                    value={text}
                    error={error}
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!disabled}
                    onChangeText={(next) => {
                        setTyped(next);
                        const hex = normalizeAccent(next);
                        if (isValidAccent(hex)) onChange(hex);
                    }}
                />
            </FieldRow>
        </Group>
    );
}
