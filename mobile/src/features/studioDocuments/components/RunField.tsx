/**
 * One editable stretch of the document's text (model/htmlRuns.ts), labelled
 * with the block it sits in and its section. A template marker
 * (`{{#each lines}}`) is structure, shown read-only.
 */

import React, { useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Text, TextField } from '@/shared/ui';

import type { RunBlock, TextRun } from '../model/htmlRuns';

function blockLabel(t: TranslateFn, run: TextRun): string {
    const labels: Record<RunBlock, string> = {
        heading: t('mobile.studio_documents.block.heading', 'Heading {level}', { level: run.tag.slice(1) }),
        paragraph: t('mobile.studio_documents.block.paragraph', 'Paragraph'),
        listItem: t('mobile.studio_documents.block.list_item', 'List item'),
        cell: t('mobile.studio_documents.block.cell', 'Table cell'),
        header: t('mobile.studio_documents.block.header', 'Header'),
        footer: t('automations.presentation_fields.footer', 'Footer'),
        text: t('mobile.studio_documents.block.text', 'Text'),
    };
    return labels[run.block];
}

export interface RunFieldProps {
    run: TextRun;
    /** The run's current text (its edit, if any). */
    initial: string;
    sectionTitle: string | null;
    editable: boolean;
    onEdit: (index: number, text: string) => void;
}

export function RunField({ run, initial, sectionTitle, editable, onEdit }: RunFieldProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [text, setText] = useState(initial);
    const label = sectionTitle ? `${blockLabel(t, run)} · ${sectionTitle}` : blockLabel(t, run);
    if (run.marker) {
        return (
            <View style={styles.marker}>
                <Text variant="label" tone="tertiary">
                    {t('mobile.studio_documents.block.marker', 'Template marker')}
                </Text>
                <Text variant="code" tone="secondary">
                    {run.text}
                </Text>
            </View>
        );
    }
    return (
        <TextField
            label={label}
            value={text}
            editable={editable}
            multiline
            maxLines={8}
            onChangeText={(next) => {
                setText(next);
                onEdit(run.index, next);
            }}
            testID={`document-run-${run.index}`}
        />
    );
}

const makeStyles = (theme: Theme) => ({
    marker: {
        gap: theme.spacing[1],
        paddingVertical: theme.spacing[2],
        paddingHorizontal: theme.spacing[3],
        borderRadius: theme.radii.md,
        borderWidth: 1,
        borderStyle: 'dashed',
        borderColor: theme.colors.borderDefault,
    } satisfies ViewStyle,
});
