/**
 * A list of short strings typed one at a time: allowed domains, custom
 * sensitive terms, allow-listed terms, e-mail addresses. Each value is a
 * removable chip. `validate` returns an error sentence or null, and a value
 * already in the list is not added twice. Normalising (trim, lower case) is
 * the caller's `normalize`, because a domain and a term differ.
 *
 * A typed value is added three ways, because nobody expects to have to press
 * Enter first: Enter, the + button beside the field (which says there is an
 * add step at all), and leaving the field. What none of them sees is a
 * button outside the scroll view — a Save bar, a sheet's footer — since
 * pressing one does not take the focus on Android. A caller whose Save or
 * Close is such a button asks the field itself through the `ref`: `commit()`
 * adds what is typed and says whether it could.
 */

import React, { useImperativeHandle, useState, type Ref } from 'react';
import { StyleSheet, View, type TextInputProps } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';

import { Chip } from './Chip';
import { IconButton } from './IconButton';
import { Icon } from './icons/Icon';
import { Text } from './Text';
import { TextField } from './TextField';

/** What a caller may ask of the field through its `ref`. */
export interface TagInputHandle {
    /** Adds what is typed. False when it was refused; the field then says why. */
    commit: () => boolean;
}

export interface TagInputProps {
    values: readonly string[];
    onChange: (next: string[]) => void;
    label?: string;
    placeholder?: string;
    hint?: string;
    /** An error sentence for a value that may not be added, else null. */
    validate?: (value: string) => string | null;
    normalize?: (value: string) => string;
    /** `email-address` for a list of e-mail addresses. */
    keyboardType?: TextInputProps['keyboardType'];
    disabled?: boolean;
    testID?: string;
    ref?: Ref<TagInputHandle>;
}

/** The list after adding `raw`, or the reason it was refused. Pure; tested. */
export function addTag(
    values: readonly string[],
    raw: string,
    normalize: (v: string) => string = (v) => v.trim(),
    validate?: (v: string) => string | null,
): { next: string[] } | { error: string | null } {
    const value = normalize(raw);
    if (!value) return { error: null };
    if (values.includes(value)) return { next: [...values] };
    const error = validate?.(value) ?? null;
    return error ? { error } : { next: [...values, value] };
}

export function TagInput({
    values,
    onChange,
    label,
    placeholder,
    hint,
    validate,
    normalize,
    keyboardType,
    disabled = false,
    testID,
    ref,
}: TagInputProps) {
    const t = useTranslation();
    const theme = useTheme();
    const [draft, setDraft] = useState('');
    const [error, setError] = useState<string | null>(null);
    const pending = draft.trim().length > 0;

    const submit = (): boolean => {
        const result = addTag(values, draft, normalize, validate);
        if ('error' in result) {
            setError(result.error);
            return result.error === null;
        }
        setError(null);
        setDraft('');
        onChange(result.next);
        return true;
    };

    useImperativeHandle(ref, () => ({ commit: submit }));

    return (
        <View style={styles.wrap}>
            <View style={styles.entry}>
                {/* Above the row rather than inside the field, so the + lines up with the box. */}
                {label ? (
                    <Text variant="caption" tone="secondary" weight="medium">
                        {label}
                    </Text>
                ) : null}
                <View style={styles.row}>
                    <TextField
                        testID={testID}
                        accessibilityLabel={label}
                        containerStyle={styles.field}
                        placeholder={placeholder}
                        hint={hint}
                        error={error}
                        value={draft}
                        editable={!disabled}
                        autoCapitalize="none"
                        autoCorrect={false}
                        keyboardType={keyboardType}
                        returnKeyType="done"
                        submitBehavior="submit"
                        onChangeText={(text) => {
                            setDraft(text);
                            if (error) setError(null);
                        }}
                        onSubmitEditing={submit}
                        onBlur={() => {
                            if (pending) submit();
                        }}
                    />
                    <IconButton
                        testID={testID ? `${testID}-add` : undefined}
                        icon={<Icon name="Plus" size={20} color={theme.colors.textSecondary} />}
                        accessibilityLabel={t('common.add', 'Add')}
                        disabled={disabled || !pending}
                        onPress={submit}
                    />
                </View>
            </View>
            {values.length > 0 ? (
                <View style={styles.chips}>
                    {values.map((value) => (
                        <Chip
                            key={value}
                            label={value}
                            disabled={disabled}
                            icon={<Icon name="X" size={12} color={theme.colors.textSecondary} />}
                            accessibilityHint={t('mobile.ui.tag_remove_hint', 'Removes it from the list')}
                            onPress={() => onChange(values.filter((v) => v !== value))}
                        />
                    ))}
                </View>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create({
    wrap: { gap: 8 },
    // TextField's own gap between its label and its box.
    entry: { gap: 4 },
    row: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
    field: { flex: 1 },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
});
