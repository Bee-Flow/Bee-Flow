/**
 * The transcript: an inverted FlatList of message bubbles.
 *
 * Inverted because a chat is read from the bottom: it puts the newest message
 * at the natural scroll position with no scrollToEnd on every token, and it
 * means keyboard-driven resizes keep the latest message pinned rather than
 * jumping.
 *
 * While an answer streams, only its cell (TranscriptCell) reads the live
 * turn. `renderItem` depends on nothing that changes per token, and what a
 * message may do (rate, retry, edit) arrives by context rather than props,
 * so the finished bubbles — each one a markdown tree — do not re-render at
 * 20 Hz. The list is also the answers' scroll host, so an in-answer
 * `#heading` link moves the transcript to that heading.
 *
 * A turn that starts — a question sent, a retry, an edit — brings the list
 * back to the newest message, where its question and answer appear; read
 * from further up, they would land out of view with no sign that anything
 * happened. While scrolled away, a ↓ button leads back. The start of a turn
 * is read off the list itself (a new streaming placeholder at its head), so
 * every chat that draws this transcript gets both.
 */

import React, { memo, useCallback, useEffect, useMemo } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { TranscriptActionsContext, type TranscriptActions } from '@/features/chat/hooks/transcriptActions';
import { useListScrollHost } from '@/features/chat/hooks/useListScrollHost';
import type { TurnAnswer } from '@/features/chat/model/answer';
import { withTurnContext } from '@/features/chat/model/turnContext';
import type { ChatMessage } from '@/features/chat/model/types';
import { MarkdownScrollHostProvider } from '@/shared/markdown';
import type { TurnSource } from '@/shared/stream';

import { JumpToLatest } from './JumpToLatest';
import { TranscriptCell } from './TranscriptCell';

export interface ChatTranscriptProps {
    /** Newest first. */
    messages: ChatMessage[];
    /** The live turn; the streaming placeholder draws its parts from here. */
    store: TurnSource<TurnAnswer>;
    /** What the messages may do. Memoise it: a new object re-renders every bubble. */
    actions?: TranscriptActions;
}

const makeStyles = (theme: Theme) => ({
    content: { paddingVertical: theme.spacing.lg },
});

const keyOf = (m: ChatMessage) => m.id;
const NO_ACTIONS: TranscriptActions = {};

export const ChatTranscript = memo(function ChatTranscript({ messages, store, actions = NO_ACTIONS }: ChatTranscriptProps) {
    const styles = useThemedStyles(makeStyles);
    const scroll = useListScrollHost();
    const data = useMemo(() => withTurnContext(messages), [messages]);

    // Newest first: a streaming message at the head is a turn under way, and
    // a new one there is a turn that just started.
    const head = messages[0];
    const startedTurn = head?.streaming ? head.id : null;
    const { toLatest } = scroll;
    useEffect(() => {
        if (startedTurn) toLatest(false);
    }, [startedTurn, toLatest]);

    const renderItem = useCallback(({ item }: { item: ChatMessage }) => <TranscriptCell store={store} message={item} />, [store]);

    return (
        <TranscriptActionsContext.Provider value={actions}>
            <MarkdownScrollHostProvider host={scroll.host}>
                <View ref={scroll.frame} style={fixed.frame} collapsable={false}>
                    <FlatList
                        ref={scroll.list}
                        data={data}
                        keyExtractor={keyOf}
                        renderItem={renderItem}
                        inverted
                        onScroll={scroll.onScroll}
                        scrollEventThrottle={64}
                        keyboardDismissMode="interactive"
                        keyboardShouldPersistTaps="handled"
                        contentContainerStyle={styles.content}
                        // A long transcript with markdown in every row is the one place
                        // this app can drop frames; these keep the window tight without
                        // making scrolling feel empty.
                        initialNumToRender={12}
                        maxToRenderPerBatch={8}
                        windowSize={11}
                        removeClippedSubviews
                    />
                    {scroll.away ? <JumpToLatest onPress={() => toLatest(true)} /> : null}
                </View>
            </MarkdownScrollHostProvider>
        </TranscriptActionsContext.Provider>
    );
});

const fixed = StyleSheet.create({ frame: { flex: 1 } });
