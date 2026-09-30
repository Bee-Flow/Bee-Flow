/**
 * Where this answer came from, directly under it (the web's AnswerChips.jsx):
 * a chip per cited document that opens its best passage ("×3" when it folds
 * several), a muted chip for a source
 * whose passage did not come with the answer, "+N more" for what does not
 * fit, and — on a surface that asks for it — the rules a second model judged
 * the answer to follow, dashed because they are an opinion, not a record.
 *
 * Hidden while the answer streams: citations land mid-turn, and a row saying
 * where an answer came from before the answer exists is a claim about
 * nothing.
 */

import React, { useState } from 'react';
import { View } from 'react-native';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useTranscriptActions } from '@/features/chat/hooks/transcriptActions';
import { answerChipsFor, citationIsOpenable } from '@/features/chat/model/answerChips';
import { chipLabel, passageCountOf, passagesNote, type CitationChip } from '@/features/chat/model/citationLabel';
import type { ChatMessage, KbSource } from '@/features/chat/model/types';
import { Chip, Text } from '@/shared/ui';

import { CitationSheet } from './CitationSheet';

/** The chip's words, with "×3" after them when it folds several passages of one document. */
function labelOf(source: CitationChip, index: number, t: TranslateFn): string {
    const count = passageCountOf(source);
    const label = chipLabel(source, index, t);
    return count ? `${label} ${t('chat.citation_passage_count', '×{count}', { count })}` : label;
}

const makeStyles = (theme: Theme) => ({
    block: { marginTop: theme.spacing.sm, gap: theme.spacing[1.5] },
    row: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, alignItems: 'center' as const, gap: theme.spacing[1.5] },
    judged: { borderTopWidth: 1, borderStyle: 'dashed' as const, borderTopColor: theme.colors.borderSubtle, paddingTop: theme.spacing[1.5] },
});

export function AnswerChips({ message }: { message: ChatMessage }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const { showSources, showProcess = false } = useTranscriptActions();
    const [open, setOpen] = useState<{ source: KbSource; index: number } | null>(null);
    const chips = answerChipsFor(message, { showSources, showProcess });
    if (chips.isEmpty || message.streaming) return null;

    const more =
        chips.citationsHidden === 1
            ? t('agent_studio.answer_chips_more', '+{count} more source', { count: 1 })
            : t('agent_studio.answer_chips_more_plural', '+{count} more sources', { count: chips.citationsHidden });

    return (
        <View style={styles.block}>
            {chips.hasRecorded ? (
                <View style={styles.row}>
                    {chips.citations.map((source, index) =>
                        citationIsOpenable(source) ? (
                            <Chip
                                key={source.chunkId ?? `${index}`}
                                label={labelOf(source, index, t)}
                                onPress={() => setOpen({ source, index })}
                                accessibilityHint={passagesNote(source, t) ?? undefined}
                            />
                        ) : (
                            <Chip
                                key={source.chunkId ?? `${index}`}
                                label={labelOf(source, index, t)}
                                tone="muted"
                                accessibilityHint={t(
                                    'chat.source_closed_hint',
                                    'The passage behind this source did not come with the answer, so it cannot be opened here',
                                )}
                            />
                        ),
                    )}
                    {chips.citationsHidden > 0 ? (
                        <Text variant="label" tone="tertiary">
                            {more}
                        </Text>
                    ) : null}
                </View>
            ) : null}
            {chips.hasJudged ? (
                <View style={[styles.row, styles.judged]}>
                    <Text variant="label" tone="tertiary">
                        {t('agent_studio.answer_chips_judged', 'Judged').toUpperCase()}
                    </Text>
                    {chips.rules.map(({ rule }) => (
                        <Chip key={rule} label={t('agent_studio.chip_rule_followed', 'Rule followed: {rule}', { rule })} tone="muted" />
                    ))}
                </View>
            ) : null}
            <CitationSheet citation={open} onClose={() => setOpen(null)} />
        </View>
    );
}
