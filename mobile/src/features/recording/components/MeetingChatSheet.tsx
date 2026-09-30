/**
 * "Ask about this meeting" — a chat whose context is one transcript.
 *
 * The state, the prompt and why this bypasses the persisted chat live in
 * hooks/useMeetingChat.ts and model/meetingPrompt.ts. Nothing is persisted:
 * the thread is gone when the sheet closes, which is the honest behaviour for
 * a conversation about a document you are looking at.
 */

import React, { useRef } from 'react';
import { ScrollView, View } from 'react-native';

import { useTheme } from '@/core/theme/ThemeProvider';
import { Chip, Text } from '@/shared/ui';

import { MeetingChatBubble } from './MeetingChatBubble';
import { MeetingChatInput } from './MeetingChatInput';
import { useMeetingChat } from '../hooks/useMeetingChat';
import type { Transcription } from '../model/types';

export function MeetingChatSheetBody({ meeting }: { meeting: Transcription }) {
    const theme = useTheme();
    const scroller = useRef<ScrollView>(null);
    const { turns, input, setInput, error, streaming, stop, liveText, suggestions, send } = useMeetingChat(meeting);

    return (
        <View style={{ gap: theme.spacing.md, maxHeight: 460 }}>
            <ScrollView
                ref={scroller}
                onContentSizeChange={() => scroller.current?.scrollToEnd({ animated: true })}
                contentContainerStyle={{ gap: theme.spacing.lg, paddingBottom: theme.spacing.md }}
                keyboardShouldPersistTaps="handled"
            >
                {turns.length === 0 ? (
                    <View style={{ gap: theme.spacing.sm }}>
                        <Text variant="caption" tone="tertiary">
                            Answers come only from this meeting&apos;s transcript. Nothing is saved to
                            your chat history.
                        </Text>
                        <View style={{ gap: theme.spacing.sm, alignItems: 'flex-start' }}>
                            {suggestions.map((suggestion) => (
                                <Chip
                                    key={suggestion}
                                    label={suggestion}
                                    onPress={() => void send(suggestion)}
                                />
                            ))}
                        </View>
                    </View>
                ) : null}

                {turns.map((turn, index) => {
                    const isLast = index === turns.length - 1;
                    // The trailing answer is drawn from the live stream until it ends.
                    const content = streaming && isLast ? liveText : turn.content;
                    return <MeetingChatBubble key={index} turn={turn} content={content} isLast={isLast} />;
                })}

                {error ? (
                    <Text variant="caption" tone="error">
                        {error}
                    </Text>
                ) : null}
            </ScrollView>

            <MeetingChatInput
                value={input}
                onChange={setInput}
                onSend={() => void send(input)}
                streaming={streaming}
                onStop={stop}
            />
        </View>
    );
}
