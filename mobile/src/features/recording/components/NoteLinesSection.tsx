/**
 * A titled card of one-line notes with a leading mark — the meeting's
 * decisions, and the questions it left open.
 */

import React from 'react';
import { View } from 'react-native';

import { useThemedStyles } from '@/core/theme/ThemeProvider';
import { Card, Icon, Section, Text, type IconName } from '@/shared/ui';

import { makeMeetingStyles } from './meetingStyles';

export function NoteLinesSection({
    title,
    lines,
    icon,
    colour,
}: {
    title: string;
    lines: readonly { text: string }[];
    icon: IconName;
    colour: string;
}) {
    const styles = useThemedStyles(makeMeetingStyles);
    if (lines.length === 0) return null;
    return (
        <Section title={title}>
            <Card>
                <View style={styles.stackMd}>
                    {lines.map((line, index) => (
                        <View key={`${index}-${line.text}`} style={styles.line}>
                            <Icon name={icon} size={14} color={colour} style={styles.lineIcon} />
                            <Text variant="body" tone="secondary" style={styles.lineText}>
                                {line.text}
                            </Text>
                        </View>
                    ))}
                </View>
            </Card>
        </Section>
    );
}
