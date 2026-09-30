/**
 * "Build it with AI", create mode — the web's AiTablePanel inside the new-table
 * sheet: describe the rows (or paste a header line), and the columns are
 * drafted for the person to check before Create. Nothing is stored by the
 * draft itself; POST /ai/draft is rate-limited to ten a minute.
 */

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ApiError } from '@/core/api/client';
import { describeError } from '@/core/api/errors';
import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Text, TextField } from '@/shared/ui';

import { useDraftDatatable } from '../hooks/tableMutations';
import { COLUMN_TYPES } from '../model/columns';
import type { ColumnDraft, TableDraft } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        block: {
            gap: theme.spacing.sm,
            padding: theme.spacing.md,
            borderRadius: theme.radii.md,
            borderWidth: 1,
            borderColor: theme.colors.borderDefault,
            backgroundColor: theme.colors.bgSecondary,
        },
        actions: { flexDirection: 'row', gap: theme.spacing.sm, alignItems: 'center' },
    });

function draftError(t: TranslateFn, err: unknown): string {
    const code = err instanceof ApiError ? err.code : undefined;
    if (code === 'no_model') return t('datatables.ai_err_no_model', 'No AI model is set up for this workspace yet.');
    if (code === 'ai_unusable') return t('datatables.ai_err_unusable', 'The AI did not return a usable table. Try again, or describe it more concretely.');
    if (err instanceof ApiError && err.status === 429) return t('datatables.ai_err_rate', 'Too many drafts in a minute — wait a moment and try again.');
    return describeError(err).message || t('datatables.ai_err_failed', 'Could not draft the columns.');
}

function typeWord(t: TranslateFn, type: ColumnDraft['type']): string {
    const entry = COLUMN_TYPES.find((c) => c.type === type);
    return entry ? t(entry.key, entry.fallback) : type;
}

export function AiDraftField({
    fields,
    onDraft,
    onClearFields,
}: {
    fields: readonly ColumnDraft[];
    onDraft: (draft: TableDraft) => void;
    onClearFields: () => void;
}) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const [brief, setBrief] = useState('');
    const [notes, setNotes] = useState<string | null>(null);
    const draft = useDraftDatatable();
    const run = () => {
        if (!brief.trim()) return;
        draft.mutate(brief.trim(), {
            onSuccess: (result) => {
                if (!result) return;
                setNotes(result.notes);
                onDraft(result);
            },
        });
    };
    return (
        <View style={styles.block}>
            <Text variant="label" weight="semibold">
                {t('datatables.ai_title', 'Build it with AI')}
            </Text>
            <TextField
                value={brief}
                onChangeText={setBrief}
                multiline
                placeholder={t('datatables.ai_placeholder', 'e.g. Supplier invoices: supplier, invoice number, date, amount excl. VAT, VAT %, total, status (new / approved / rejected)')}
                hint={t('datatables.ai_intro', 'Describe what the rows should hold, or paste what the columns should be based on — a spreadsheet’s header row, an e-mail, a list. The fields below are filled in for you to check.')}
                error={draft.error ? draftError(t, draft.error) : null}
                testID="ai-draft-brief"
            />
            <View style={styles.actions}>
                <Button
                    size="sm"
                    variant="secondary"
                    iconName="Sparkles"
                    label={draft.isPending ? t('datatables.ai_running', 'Drafting…') : t('datatables.ai_run', 'Draft the columns')}
                    loading={draft.isPending}
                    disabled={!brief.trim()}
                    onPress={run}
                />
                {fields.length ? <Button size="sm" variant="ghost" label={t('datatables.ai_undo', 'Undo')} onPress={onClearFields} /> : null}
            </View>
            {fields.length ? (
                <Text variant="caption" tone="secondary">
                    {t('datatables.ai_done_create', '{count} columns drafted — check them below, then Create.', { count: fields.length })}
                    {'\n'}
                    {fields.map((f) => `${f.name} · ${typeWord(t, f.type)}`).join('\n')}
                </Text>
            ) : null}
            {notes && fields.length ? (
                <Text variant="caption" tone="tertiary">
                    {notes}
                </Text>
            ) : null}
        </View>
    );
}
