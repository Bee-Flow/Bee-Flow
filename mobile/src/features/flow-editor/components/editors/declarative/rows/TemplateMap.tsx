/**
 * Values under fixed names, each a template — a document's placeholders.
 * The names come from what is stored (the web reads them off the document);
 * a value can be retyped or bound, not renamed. A number or a yes/no typed
 * into one is stored as that, as the web's fill editor stores it.
 */

import React, { useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { BindingInput } from '@/features/flow-editor/components/fields';
import { isCompose, isPick } from '@/shared/mapping';
import { Text } from '@/shared/ui';

/** Text as the value it spells: a number, true / false, or the text itself. */
export function typedTemplateValue(text: string, previous: unknown): unknown {
    if (typeof previous === 'number' && text.trim() && Number.isFinite(Number(text))) return Number(text);
    if (typeof previous === 'boolean' && (text === 'true' || text === 'false')) return text === 'true';
    return text;
}

function asText(value: unknown): string {
    return value == null ? '' : String(value);
}

/**
 * What a value's field shows: its text, or a pick or composed text the v2
 * mapping stored (a fill_document value lifted from a sole placeholder is a
 * pick), passed through whole so it is never shown or saved as "[object Object]".
 */
function fieldValue(value: unknown, typed: string | undefined): unknown {
    if (isCompose(value) || isPick(value)) return value;
    return typed !== undefined && typedTemplateValue(typed, value) === value ? typed : asText(value);
}

export function TemplateMap({ value, onChange, disabled }: { value: unknown; onChange: (next: Record<string, unknown>) => void; disabled?: boolean }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    // What was typed, per name: '4.' on its way to 4.5 is stored as 4, and
    // showing the stored 4 again took the dot away mid-number. The typed text
    // stays on screen while it still means what is stored.
    const [typed, setTyped] = useState<Record<string, string>>({});
    const map = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    const keys = Object.keys(map);
    const shown = (key: string) => fieldValue(map[key], typed[key]);
    if (!keys.length) {
        return (
            <Text variant="caption" tone="tertiary">
                {t('mobile.flow.fill.no_values', 'No placeholder is filled yet.')}
            </Text>
        );
    }
    return (
        <View style={styles.list}>
            {keys.map((key) => (
                <BindingInput
                    key={key}
                    mode="template"
                    label={key}
                    value={shown(key)}
                    onChange={(next) => {
                        if (typeof next !== 'string') {
                            onChange({ ...map, [key]: next });
                            return;
                        }
                        setTyped((prev) => ({ ...prev, [key]: next }));
                        onChange({ ...map, [key]: typedTemplateValue(next, map[key]) });
                    }}
                    disabled={disabled}
                />
            ))}
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    list: { gap: theme.spacing.lg } satisfies ViewStyle,
});
