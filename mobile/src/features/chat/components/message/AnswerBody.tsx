/**
 * The answer's text: the live status line before the first token, then the
 * Markdown, and under it the error card of a turn that failed. A turn that
 * failed halfway keeps the words that did arrive: on a phone the connection
 * drops mid-answer often, and wiping the paragraphs being read for "Something
 * went wrong" loses what the person was reading. Full width with no
 * background — a long answer in a rounded rectangle wastes a phone's width on
 * decoration.
 *
 * `streaming` goes to the renderer so a rich fence that has not closed yet
 * shows "Building…" rather than half a JSON document. When the turn produced
 * images, their markdown is dropped from the text as on the web: the
 * pictures render below from the stored files, and a second copy inline would
 * be a broken data URL at best.
 */

import React from 'react';
import { Pressable, View } from 'react-native';

import { perTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { answerText } from '@/features/chat/model/answer';
import type { ChatMessage } from '@/features/chat/model/types';
import { Markdown } from '@/shared/markdown';

import { ErrorCard } from './ErrorCard';
import { PhaseLine } from './PhaseLine';

// Every answer in the transcript asks for it: built once per theme.
const makeStyles = perTheme((theme: Theme) => ({
    failed: { gap: theme.spacing.sm },
}));

export function AnswerBody({
    message,
    onRetry,
    onLongPress,
}: {
    message: ChatMessage;
    onRetry?: () => void;
    onLongPress: () => void;
}) {
    const styles = useThemedStyles(makeStyles);
    const words = message.content ? <AnswerWords message={message} onLongPress={onLongPress} /> : null;
    if (message.error) {
        return (
            <View style={styles.failed}>
                {words}
                <ErrorCard error={message.error} onRetry={onRetry} />
            </View>
        );
    }
    if (!words) return message.streaming ? <PhaseLine message={message} /> : null;
    return words;
}

function AnswerWords({ message, onLongPress }: { message: ChatMessage; onLongPress: () => void }) {
    // `accessible={false}` on the wrapper, not the child: TalkBack otherwise
    // flattens a long answer into one unnavigable node, and the long-press
    // target becomes the whole screen.
    return (
        <Pressable onLongPress={onLongPress} accessible={false}>
            <View accessibilityLiveRegion={message.streaming ? 'polite' : 'none'}>
                <Markdown value={answerText(message)} streaming={Boolean(message.streaming)} />
            </View>
        </Pressable>
    );
}
