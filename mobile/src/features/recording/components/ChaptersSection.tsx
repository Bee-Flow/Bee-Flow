/** The meeting's chapters: a clock string, a title and an optional one-liner. */

import React from 'react';
import { View } from 'react-native';

import { useThemedStyles } from '@/core/theme/ThemeProvider';
import { Section, Text } from '@/shared/ui';

import { makeMeetingStyles } from './meetingStyles';
import type { Chapter } from '../model/types';

export function ChaptersSection({ chapters }: { chapters: Chapter[] }) {
    const styles = useThemedStyles(makeMeetingStyles);
    if (chapters.length === 0) return null;
    return (
        <Section title="Chapters">
            <View style={styles.stackSm}>
                {chapters.map((chapter, index) => (
                    <View key={`${index}-${chapter.start}`} style={styles.chapter}>
                        <Text variant="label" tone="tertiary" style={styles.chapterStart}>
                            {chapter.start}
                        </Text>
                        <View style={styles.chapterBody}>
                            <Text variant="body">{chapter.title}</Text>
                            {chapter.summary ? (
                                <Text variant="caption" tone="tertiary">
                                    {chapter.summary}
                                </Text>
                            ) : null}
                        </View>
                    </View>
                ))}
            </View>
        </Section>
    );
}
