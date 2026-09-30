/**
 * The control that swaps a value between its readable form and its exact
 * one: "Show raw", and back to "Show table" / "Show fields" / "Show list" /
 * "Show text" — named after what the readable form of THIS value is.
 *
 * ValuePreview draws it over its own raw sheet; the flow editor's Output tab
 * and test-run cards draw it over their JSON tree.
 */

import React from 'react';
import { Pressable } from 'react-native';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { Text } from '@/shared/ui';

import { describeValue } from '../model/values';

// 44dp is the platform minimum for a touch target; a 15px label is nowhere
// near it without the hit slop.
const HIT_SLOP = { top: 12, bottom: 12, left: 12, right: 12 };

/** What the readable form of a value is called on the button that returns to it. */
export function readableWord(value: unknown, t: TranslateFn): string {
    const kind = describeValue(value).kind;
    if (kind === 'scalar') return t('mobile.automations.value.show_text', 'Show text');
    if (kind === 'rows') return t('mobile.automations.value.show_table', 'Show table');
    if (kind === 'list' || Array.isArray(value)) return t('mobile.automations.value.show_list', 'Show list');
    return t('mobile.automations.value.show_fields', 'Show fields');
}

export function RawToggle({
    value,
    raw,
    onToggle,
    subject,
    testID,
}: {
    value: unknown;
    raw: boolean;
    onToggle: () => void;
    /** What the value is ("Received", "Output"), for a screen reader. */
    subject?: string;
    testID?: string;
}) {
    const t = useTranslation();
    const word = raw ? readableWord(value, t) : t('mobile.automations.value.show_raw', 'Show raw');
    return (
        <Pressable
            onPress={onToggle}
            hitSlop={HIT_SLOP}
            accessibilityRole="button"
            accessibilityState={{ expanded: raw }}
            accessibilityLabel={subject ? `${word}: ${subject}` : word}
            testID={testID}
        >
            <Text variant="label" tone="accent">
                {word}
            </Text>
        </Pressable>
    );
}
