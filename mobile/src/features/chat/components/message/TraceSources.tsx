/**
 * The sources behind an answer, in the trace sheet (the web's
 * KbSourcesPanel): one card per DOCUMENT, not per passage (BFSF-352), under
 * "10 sources from 3 documents".
 *
 * A document with one passage shows where it sits and the passage itself,
 * three lines, the rest a tap away. A document with several says how many
 * ("3 passages from this document"), and a tap lists each one: its heading
 * and page, and the passage in full.
 */

import React, { useState } from 'react';
import { Pressable, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { passagePlace, sourcesHeading, traceDocuments } from '@/features/chat/model/answerTrace';
import { chipLabel, passagesNote } from '@/features/chat/model/citationLabel';
import type { KbSource } from '@/features/chat/model/types';
import { Text } from '@/shared/ui';

const makeStyles = (theme: Theme) => ({
    section: { gap: theme.spacing.sm },
    source: {
        gap: theme.spacing.xxs,
        padding: theme.spacing.sm,
        borderRadius: theme.radii.sm,
        backgroundColor: theme.colors.bgTertiary,
    },
    passage: {
        gap: theme.spacing.xxs,
        marginTop: theme.spacing.xs,
        paddingTop: theme.spacing.xs,
        borderTopWidth: 1,
        borderTopColor: theme.colors.borderSubtle,
    },
});

export function TraceSources({ sources }: { sources: readonly KbSource[] }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [open, setOpen] = useState<string | null>(null);
    return (
        <View style={styles.section}>
            <Text variant="label" tone="tertiary">
                {sourcesHeading(sources, t).toUpperCase()}
            </Text>
            {traceDocuments(sources, t).map(({ key, head, passages }, index) => {
                const expanded = open === key;
                const note = passagesNote(head, t);
                return (
                    <Pressable
                        key={key}
                        onPress={() => setOpen(expanded ? null : key)}
                        accessibilityRole="button"
                        accessibilityState={{ expanded }}
                        style={styles.source}
                    >
                        <Text variant="caption" weight="medium">
                            {chipLabel(head, index, t)}
                        </Text>
                        {note ? (
                            <Text variant="caption" tone="tertiary">
                                {note}
                            </Text>
                        ) : head.snippet ? (
                            <Text variant="caption" tone="secondary" numberOfLines={expanded ? undefined : 3} selectable={expanded}>
                                {head.snippet}
                            </Text>
                        ) : null}
                        {note && expanded
                            ? passages.map((passage, at) => (
                                  <View key={passage.chunkId ?? `${at}`} style={styles.passage}>
                                      <Text variant="caption" tone="tertiary">
                                          {passagePlace(passage, at, t)}
                                      </Text>
                                      {passage.snippet ? (
                                          <Text variant="caption" tone="secondary" selectable>
                                              {passage.snippet}
                                          </Text>
                                      ) : null}
                                  </View>
                              ))
                            : null}
                    </Pressable>
                );
            })}
        </View>
    );
}
