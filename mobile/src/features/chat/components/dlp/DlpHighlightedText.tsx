/**
 * The message under review with every finding highlighted in its group's
 * colour (the web's DlpHighlightedText). The web marks a missed value by
 * selecting it; a phone's selection handles are no way to do that, so here
 * a TAP on a word marks it, and a tap on your own mark takes it back. A
 * detector's finding cannot be unmarked — the person decides with the
 * buttons, not by hiding what was found.
 */

import React from 'react';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { bandAlpha, categorySlot } from '@/features/chat/model/dlpCategories';
import { positionedRuns, wordPieces, type DlpSpan } from '@/features/chat/model/dlpSpans';
import { Text, tint } from '@/shared/ui';

/** Past this, words are not made tappable one by one: a long document would be thousands of nodes. */
const TAPPABLE_MAX = 12000;
const SLOTS = [0, 1, 2, 3, 4, 5, 6, 7] as const;
const ALPHAS = [9, 15, 22] as const;

const makeStyles = (theme: Theme) => ({
    mark: SLOTS.map((i) =>
        Object.fromEntries(ALPHAS.map((a) => [a, { backgroundColor: tint(theme.pii[i], a), color: theme.colors.textPrimary }])),
    ) as Record<number, { backgroundColor: string; color: string }>[],
});

export function DlpHighlightedText({
    text,
    spans,
    onMark,
    onUnmark,
}: {
    text: string;
    spans: readonly DlpSpan[];
    onMark: (mark: { offset: number; length: number; text: string }) => void;
    onUnmark: (id: string) => void;
}) {
    const styles = useThemedStyles(makeStyles);
    const tappable = text.length <= TAPPABLE_MAX;
    return (
        <Text variant="body" selectable={!tappable}>
            {positionedRuns(text, spans).map((run, index) => {
                const { start } = run;
                if (run.type === 'span') {
                    const style = styles.mark[categorySlot(run.category)]?.[bandAlpha(run.confidenceBand)];
                    const mine = run.source === 'manual';
                    return (
                        <Text key={`s${index}`} style={style} onPress={mine ? () => onUnmark(run.id) : undefined}>
                            {run.value}
                        </Text>
                    );
                }
                if (!tappable) return run.value;
                return wordPieces(run.value, start).map((piece) =>
                    piece.kind === 'gap' ? (
                        piece.text
                    ) : (
                        <Text key={`w${piece.offset}`} onPress={() => onMark({ offset: piece.offset, length: piece.length, text: piece.word })}>
                            {piece.word}
                        </Text>
                    ),
                );
            })}
        </Text>
    );
}
