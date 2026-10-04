/**
 * A presentation's outline, as text — the web's DeckOutlineEditor. The deck
 * grammar (core/documents/deckModel.js) is a dozen lines, listed under "How
 * to write slides"; the slides themselves are drawn by the server, in the
 * PDF and the PowerPoint download.
 */

import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Icon, Text, TextField } from '@/shared/ui';

const styles = StyleSheet.create({
    body: { padding: 16, gap: 12, paddingBottom: 48 },
    toggle: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44 },
    rows: { gap: 6 },
});

function grammar(t: TranslateFn): [string, string][] {
    return [
        ['# Title', t('mobile.studio_documents.outline.title', 'cover title (once)')],
        ['## Heading', t('mobile.studio_documents.outline.slide', 'one slide per heading')],
        ['- point', t('mobile.studio_documents.outline.bullet', 'bullets; two spaces = sub-point')],
        ['### Card {icon: rocket}', t('mobile.studio_documents.outline.card', '2–6 cards per slide, with a Lucide icon')],
        ['```chart … ```', t('mobile.studio_documents.outline.chart', 'type: bar · labels: Q1, Q2 · Revenue: 10, 20')],
        ['```stats … ```', t('mobile.studio_documents.outline.stats', 'one KPI tile per line: value | label | delta')],
        ['| a | b |', t('mobile.studio_documents.outline.table', 'a table (also as a chart: <!-- chart: bar -->)')],
        ['> quote / > — name', t('mobile.studio_documents.outline.quote', 'a quote slide')],
        ['<!-- layout: timeline -->', t('mobile.studio_documents.outline.layout', 'bullets as steps; also closing, cards')],
        ['<!-- style: accent -->', t('mobile.studio_documents.outline.style', 'an emphasis slide (or dark)')],
        ['Notes: …', t('mobile.studio_documents.outline.notes', 'speaker notes for the slide')],
        ['{{customer.name}}', t('mobile.studio_documents.outline.placeholder', 'a placeholder an automation fills')],
    ];
}

export interface OutlineEditorProps {
    outline: string;
    editable: boolean;
    onChange: (outline: string) => void;
}

export function OutlineEditor({ outline, editable, onChange }: OutlineEditorProps) {
    const t = useTranslation();
    const theme = useTheme();
    const [text, setText] = useState(outline);
    const [help, setHelp] = useState(false);
    return (
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            <Pressable style={styles.toggle} onPress={() => setHelp((v) => !v)} accessibilityRole="button" accessibilityState={{ expanded: help }}>
                <Icon name={help ? 'ChevronDown' : 'ChevronRight'} size={16} color={theme.colors.textSecondary} />
                <Text variant="caption" tone="secondary">
                    {t('mobile.studio_documents.outline.how', 'How to write slides')}
                </Text>
            </Pressable>
            {help ? (
                <View style={styles.rows}>
                    {grammar(t).map(([code, meaning]) => (
                        <Text key={code} variant="caption" tone="tertiary">
                            <Text variant="code" tone="primary">
                                {code}
                            </Text>
                            {`  ${meaning}`}
                        </Text>
                    ))}
                </View>
            ) : null}
            <TextField
                label={t('mobile.studio_documents.outline.label', 'Slide outline')}
                value={text}
                editable={editable}
                multiline
                maxLines={40}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder={`# ${t('mobile.studio_documents.outline.ph_title', 'Title')}\n\n## ${t('mobile.studio_documents.outline.ph_slide', 'First slide')}\n- ${t('mobile.studio_documents.outline.ph_point', 'a point')}`}
                onChangeText={(next) => {
                    setText(next);
                    onChange(next);
                }}
                testID="deck-outline"
            />
        </ScrollView>
    );
}
