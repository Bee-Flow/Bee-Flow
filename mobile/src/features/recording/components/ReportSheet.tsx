/**
 * "Ask AI about these meetings": one question over the notes picked in the
 * library, answered as a cited markdown report (agent-hub ReportModal.jsx).
 * One-shot and never stored — closing the sheet discards the answer.
 */

import * as Clipboard from 'expo-clipboard';
import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation, type TranslateFn } from '@/core/i18n';
import { Markdown } from '@/shared/markdown/Markdown';
import { Banner, Button, Card, Chip, Sheet, Text, TextField } from '@/shared/ui';

import { useMeetingReport } from '../hooks/library';
import { useOnOpen } from '../hooks/useOnOpen';
import type { MeetingReport } from '../model/library';
import type { TranscriptionSummary } from '../model/types';

const styles = StyleSheet.create({
    stack: { gap: 12 },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    actions: { flexDirection: 'row', gap: 8 },
});

function presets(t: TranslateFn): string[] {
    return [
        t('meeting_notes.report_preset_decisions', 'Summarize the key decisions and action items across these meetings'),
        t('meeting_notes.report_preset_themes', 'What themes keep coming back, and what changed between meetings?'),
        t('meeting_notes.report_preset_open', 'List everything that is still open or unresolved'),
    ];
}

function ReportBody({ result }: { result: MeetingReport }) {
    const t = useTranslation();
    return (
        <Card>
            <Markdown value={result.report} />
            {result.usedTranscripts ? null : (
                <Text variant="caption" tone="tertiary">
                    {t(
                        'meeting_notes.report_summaries_note',
                        'Based on meeting summaries — the combined transcripts were too long to include in full.',
                    )}
                </Text>
            )}
            {result.truncatedNotes > 0 ? (
                <Text variant="caption" tone="warning">
                    {t(
                        'meeting_notes.report_truncated_note',
                        'Some meetings were too long and were shortened for this report.',
                    )}
                </Text>
            ) : null}
        </Card>
    );
}

export function ReportSheet({
    visible,
    meetings,
    onClose,
}: {
    visible: boolean;
    meetings: readonly TranscriptionSummary[];
    onClose: () => void;
}) {
    const t = useTranslation();
    const report = useMeetingReport();
    const [prompt, setPrompt] = useState('');
    const [copied, setCopied] = useState(false);
    const { reset } = report;

    // A fresh question every time the sheet opens, as the web modal does.
    useOnOpen(visible, () => {
        setPrompt('');
        setCopied(false);
    });
    useEffect(() => {
        if (visible) reset();
    }, [visible, reset]);

    const generate = (text: string) => {
        const question = text.trim();
        if (!question || report.isPending) return;
        setPrompt(question);
        report.mutate({ ids: meetings.map((m) => m.id), prompt: question });
    };
    const copy = async () => {
        if (!report.data?.report) return;
        await Clipboard.setStringAsync(report.data.report);
        setCopied(true);
    };
    const result = report.data ?? null;

    return (
        <Sheet
            visible={visible}
            onClose={onClose}
            tall
            title={t('meeting_notes.report_title', 'Ask AI about these meetings')}
            subtitle={meetings.map((m) => m.title).join(' · ')}
        >
            <View style={styles.stack}>
                <TextField
                    value={prompt}
                    onChangeText={setPrompt}
                    multiline
                    maxLines={4}
                    editable={!report.isPending}
                    placeholder={t('meeting_notes.report_placeholder', 'Ask a question or describe the report you want…')}
                />
                {!result && !report.isPending ? (
                    <View style={styles.chips}>
                        {presets(t).map((preset) => (
                            <Chip key={preset} label={preset} onPress={() => generate(preset)} />
                        ))}
                    </View>
                ) : null}
                <View style={styles.actions}>
                    <Button
                        label={
                            report.isPending
                                ? t('meeting_notes.report_generating', 'Generating…')
                                : t('meeting_notes.report_generate', 'Generate report')
                        }
                        iconName="Sparkles"
                        loading={report.isPending}
                        disabled={!prompt.trim()}
                        onPress={() => generate(prompt)}
                    />
                    {result ? (
                        <Button
                            label={copied ? t('meeting_notes.report_copied', 'Copied') : t('meeting_notes.report_copy', 'Copy')}
                            variant="secondary"
                            iconName="Copy"
                            onPress={() => void copy()}
                        />
                    ) : null}
                </View>
                {report.error ? <Banner tone="error">{describeError(report.error).message}</Banner> : null}
                {result ? <ReportBody result={result} /> : null}
            </View>
        </Sheet>
    );
}
