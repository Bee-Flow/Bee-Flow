/**
 * The written half of the call, for afterwards: the permission card until the
 * mic is allowed, an invitation until something is said, then the transcript,
 * following the newest turn because that is the one being spoken.
 */

import React, { useCallback, useRef } from 'react';
import { RefreshControl, ScrollView } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { EmptyState } from '@/shared/ui';

import { VoiceMicPermission } from './VoiceMicPermission';
import { VoiceTranscript } from './VoiceTranscript';
import type { UseVoiceSession } from '../hooks/useVoiceSession';

const makeStyles = (theme: Theme) => ({
    content: { padding: theme.spacing.lg, flexGrow: 1 },
});

export function VoiceConversation({
    voice,
    needsPermission,
    refreshing,
    onRefresh,
}: {
    voice: UseVoiceSession;
    needsPermission: boolean;
    refreshing: boolean;
    onRefresh: () => void;
}) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const scroller = useRef<ScrollView>(null);
    const connected = voice.phase !== 'offline';
    const talking = voice.messages.length > 0 || Boolean(voice.live.transcript);
    const stickToBottom = useCallback(() => scroller.current?.scrollToEnd({ animated: true }), []);

    return (
        <ScrollView
            ref={scroller}
            onContentSizeChange={stickToBottom}
            contentContainerStyle={[styles.content, { justifyContent: talking ? 'flex-end' : 'center' }]}
            refreshControl={
                <RefreshControl
                    // Only off the call: yanking the transcript around
                    // mid-answer to re-probe a capability is nobody's intent.
                    enabled={!connected}
                    refreshing={refreshing && !connected}
                    onRefresh={onRefresh}
                    tintColor={theme.colors.accentPrimary}
                    colors={[theme.colors.accentPrimary]}
                />
            }
        >
            {needsPermission ? (
                <VoiceMicPermission
                    permission={voice.permission}
                    onRequest={() => void voice.requestPermission()}
                    busy={voice.phase === 'connecting'}
                />
            ) : !talking ? (
                <EmptyState
                    icon="Mic"
                    title="Ask out loud"
                    message={
                        connected
                            ? 'Go ahead — it is listening. Everything you both say appears here as text too.'
                            : 'Tap the button below and start talking. This conversation lives on the phone only, so it goes away when you leave.'
                    }
                    actionLabel={connected ? undefined : 'Start talking'}
                    onAction={connected ? undefined : () => void voice.connect()}
                />
            ) : (
                <VoiceTranscript messages={voice.messages} live={voice.live} />
            )}
        </ScrollView>
    );
}
