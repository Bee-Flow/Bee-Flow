/**
 * The data-loss-prevention review (the web's DlpReviewShell).
 *
 * The one place in chat where the server stops and waits for a person: the
 * privacy scanner found personal data in what is about to go to a model, and
 * the turn does not move until the app posts an answer. So the review cannot
 * be swiped away — a person decides:
 *
 *   Redact and send — the findings, plus anything they marked, become
 *                     placeholders; the safe default, and the product's point.
 *   Send anyway     — as written.
 *   Block           — the turn stops.
 *
 * Android's Back is Block, as the web's cancel is: it is what the server
 * itself does with a question nobody answers (fail-closed), and a Back that
 * does nothing leaves a person with no way out but a choice about their data.
 *
 * "Remember my choice" is offered because reviewing a document is twenty
 * near-identical questions, and asking twenty times trains people to stop
 * reading. A refused decision keeps the review up with the reason, so it can
 * be answered again — unless the question is gone (the server holds it about
 * a minute): then the review has already closed and a toast says why.
 */

import React, { useMemo, useState } from 'react';
import { Modal, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { DlpQuestionExpired, type DlpChoice, type DlpResolver } from '@/features/chat/hooks/dlpResolver';
import { mergeSpans, type ManualMark } from '@/features/chat/model/dlpSpans';
import type { DlpDecision } from '@/features/chat/model/types';
import { CheckRow, Text, useToast } from '@/shared/ui';

import { DlpHighlightedText } from './DlpHighlightedText';
import { DlpReviewActions } from './DlpReviewActions';
import { DlpReviewHeader } from './DlpReviewHeader';
import { DlpSummaryBar } from './DlpSummaryBar';

const makeStyles = (theme: Theme) => ({
    root: { flex: 1, justifyContent: 'flex-end' as const, backgroundColor: 'rgba(0, 0, 0, 0.5)' },
    panel: {
        maxHeight: '92%' as const,
        backgroundColor: theme.colors.bgCard,
        borderTopLeftRadius: theme.radii.lg,
        borderTopRightRadius: theme.radii.lg,
        borderWidth: 1,
        borderColor: theme.colors.borderDefault,
    },
    body: { padding: theme.spacing.lg, gap: theme.spacing.md },
    error: { padding: theme.spacing.sm, borderRadius: theme.radii.md, backgroundColor: theme.colors.bgTertiary },
});

export function DlpReviewSheet({ decision, onChoose }: { decision: DlpDecision; onChoose: DlpResolver }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const insets = useSafeAreaInsets();
    const { toast } = useToast();
    const [remember, setRemember] = useState(false);
    const [marks, setMarks] = useState<ManualMark[]>([]);
    const [busy, setBusy] = useState<DlpChoice | null>(null);
    const [error, setError] = useState<string | null>(null);
    const spans = useMemo(() => mergeSpans(decision.findings, marks), [decision.findings, marks]);

    const choose = (choice: DlpChoice) => {
        setBusy(choice);
        setError(null);
        const additions = choice === 'redact' ? marks.map(({ offset, length }) => ({ offset, length })) : [];
        onChoose(choice, choice === 'block' ? false : remember, additions)
            .catch((err: unknown) => {
                // An expired question has left the turn, and this sheet with it.
                if (err instanceof DlpQuestionExpired) toast(describeError(err).message, 'error');
                else setError(describeError(err).message);
            })
            .finally(() => setBusy(null));
    };

    return (
        // Back blocks (see the header); while an answer is on its way, it waits.
        <Modal visible transparent animationType="slide" onRequestClose={() => busy === null && choose('block')} statusBarTranslucent testID="dlp-review">
            <View style={styles.root}>
                <View style={styles.panel} accessibilityViewIsModal accessibilityLiveRegion="assertive">
                    <DlpReviewHeader decision={decision} />
                    <ScrollView contentContainerStyle={styles.body}>
                        <DlpSummaryBar spans={spans} />
                        {decision.reviewText ? (
                            <DlpHighlightedText
                                text={decision.reviewText}
                                spans={spans}
                                onMark={(mark) => setMarks((prev) => [...prev, { ...mark, id: `manual-${prev.length}-${mark.offset}` }])}
                                onUnmark={(id) => setMarks((prev) => prev.filter((m) => m.id !== id))}
                            />
                        ) : (
                            <Text variant="body" tone="secondary">
                                {decision.summary}
                            </Text>
                        )}
                        {decision.reviewText ? (
                            <Text variant="caption" tone="tertiary">
                                {t('mobile.chat.dlp_tap_hint', 'Tip: tap a word above to mark something the detector missed.')}
                            </Text>
                        ) : null}
                        <CheckRow checked={remember} onToggle={() => setRemember((v) => !v)} label={t('dlp.remember_label', 'Remember my choice for this conversation')} />
                        {error ? (
                            <View style={styles.error}>
                                <Text variant="caption" tone="error">
                                    {error}
                                </Text>
                            </View>
                        ) : null}
                    </ScrollView>
                    <DlpReviewActions busy={busy} anyMarked={spans.length > 0} onChoose={choose} bottomInset={insets.bottom} />
                </View>
            </View>
        </Modal>
    );
}
