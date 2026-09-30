/**
 * A highlighted box — info, warning, success or tip — in the web's tints,
 * with its icon, an optional title in the variant's colour and the text.
 */

import React from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';

import { Icon, Text, type IconName } from '@/shared/ui';

import type { CalloutVariant } from './researchModel';
import { CALLOUT } from '../rich/richPalette';

const ICONS: Record<CalloutVariant, IconName> = {
    info: 'Info',
    warning: 'TriangleAlert',
    success: 'CircleCheck',
    tip: 'Lightbulb',
};

const styles = StyleSheet.create({
    box: { flexDirection: 'row', gap: 12, paddingVertical: 14, paddingHorizontal: 16, borderRadius: 12, borderWidth: 1 },
    icon: { paddingTop: 2 },
    body: { flex: 1, minWidth: 0, gap: 4 },
});

function tinted(variant: CalloutVariant): ViewStyle {
    return { backgroundColor: CALLOUT[variant].bg, borderColor: CALLOUT[variant].border };
}

function ink(variant: CalloutVariant) {
    return { color: CALLOUT[variant].color };
}

export function ResearchCallout({ variant, title, content }: { variant: CalloutVariant; title: string; content: string }) {
    return (
        <View style={[styles.box, tinted(variant)]}>
            <View style={styles.icon}>
                <Icon name={ICONS[variant]} size={20} color={CALLOUT[variant].color} />
            </View>
            <View style={styles.body}>
                {title ? (
                    <Text variant="subheading" style={ink(variant)}>
                        {title}
                    </Text>
                ) : null}
                <Text variant="caption" tone="secondary">
                    {content}
                </Text>
            </View>
        </View>
    );
}
