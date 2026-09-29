/**
 * Voice mode — a spoken conversation with Bee Flow.
 *
 * The most phone-shaped thing in the product: you hold it, you talk, it answers
 * out loud. Everything on this screen is arranged around the assumption that
 * the user is NOT looking at it — one enormous control in the thumb zone, a
 * state word big enough to read at arm's length, and the written transcript
 * above it for afterwards, when you need to check the number it just said.
 *
 * Two gates before any of that appears, because voice is a beta feature behind
 * a capability AND a configured Mistral key:
 *   1. GET /ai/voice/availability — `enabled:false` here is not an error, it is
 *      a server that has not been set up yet, and it says who can set it up.
 *   2. The microphone permission, asked for with an explanation first.
 *
 * The conversation is held entirely in the hook, because the server holds none
 * of it (server/routes/ai/voice.js is stateless per turn). Leaving this screen
 * ends the call and the transcript goes with it — which is why the screen says
 * so rather than pretending there is a history to come back to.
 */

import { Feather } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { Stack, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';

import { getAvailability, voiceKeys } from '../src/features/voice/api';
import { VoiceMicPermission } from '../src/features/voice/components/VoiceMicPermission';
import { VoiceOrb } from '../src/features/voice/components/VoiceOrb';
import { VoiceTranscript } from '../src/features/voice/components/VoiceTranscript';
import { useVoiceSession } from '../src/features/voice/useVoiceSession';
import { useTheme } from '../src/theme/ThemeProvider';
import { Button, IconButton } from '../src/ui/Button';
import {
    Banner,
    describeError,
    EmptyState,
    ErrorState,
    ListSkeleton,
} from '../src/ui/Feedback';
import { Screen } from '../src/ui/Screen';
import { ScreenHeader } from '../src/ui/ScreenHeader';

export default function VoiceScreen() {
    const theme = useTheme();
    const router = useRouter();
    const scroller = useRef<ScrollView>(null);

    const availability = useQuery({
        queryKey: voiceKeys.availability,
        queryFn: ({ signal }) => getAvailability(signal),
        // Whether the server has a Mistral key configured changes about once a
        // quarter; re-asking on every focus would be pure noise.
        staleTime: 5 * 60_000,
    });

    const voice = useVoiceSession();
    const connected = voice.phase !== 'offline';

    useEffect(() => {
        // Mount-only, and a READ rather than a prompt: the screen has to know
        // whether to show the permission card before the user touches
        // anything, and asking cold is how you burn Android's one good prompt.
        void voice.refreshPermission();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // The newest turn is the one being spoken, so the view follows the bottom.
    const stickToBottom = useCallback(() => {
        scroller.current?.scrollToEnd({ animated: true });
    }, []);

    const enabled = availability.data?.enabled ?? false;
    const needsPermission = !voice.permission.unknown && !voice.permission.granted;

    return (
        <Screen edges={['top', 'bottom']}>
            <Stack.Screen options={{ headerShown: false }} />

            <ScreenHeader
                title="Voice"
                subtitle={
                    voice.session?.agentName ??
                    availability.data?.defaultModel ??
                    'Spoken conversation'
                }
                // Leaving a live call has to end it, not just navigate away —
                // this is exactly what `onBack` exists for.
                onBack={() => {
                    if (connected) voice.hangUp();
                    router.back();
                }}
                global={false}
            />

            {availability.isLoading ? (
                <ListSkeleton rows={3} />
            ) : availability.isError ? (
                <ErrorState error={availability.error} onRetry={() => void availability.refetch()} />
            ) : !enabled ? (
                <EmptyState
                    icon="mic-off"
                    title="Voice mode is not switched on"
                    message={
                        availability.data?.reason === 'mistral_not_configured'
                            ? 'This Bee Flow server has no speech provider configured yet. An administrator can add a Mistral API key under Admin → AI Config, and voice will appear here.'
                            : 'The server could not offer voice mode just now.'
                    }
                    actionLabel="Check again"
                    onAction={() => void availability.refetch()}
                />
            ) : (
                <>
                    <ScrollView
                        ref={scroller}
                        onContentSizeChange={stickToBottom}
                        contentContainerStyle={{
                            padding: theme.spacing.lg,
                            flexGrow: 1,
                            justifyContent:
                                voice.messages.length || voice.live.transcript
                                    ? 'flex-end'
                                    : 'center',
                        }}
                        refreshControl={
                            <RefreshControl
                                // Only off the call: yanking the transcript
                                // around mid-answer to re-probe a capability
                                // that cannot have changed is nobody's intent.
                                enabled={!connected}
                                refreshing={availability.isRefetching && !connected}
                                onRefresh={() => void availability.refetch()}
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
                        ) : voice.messages.length === 0 && !voice.live.transcript ? (
                            <EmptyState
                                icon="mic"
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

                    <View
                        style={{
                            paddingHorizontal: theme.spacing.lg,
                            paddingTop: theme.spacing.md,
                            paddingBottom: theme.spacing.lg,
                            gap: theme.spacing.md,
                            borderTopWidth: 1,
                            borderTopColor: theme.colors.borderSubtle,
                        }}
                    >
                        {voice.error ? (
                            <Banner
                                tone="error"
                                action={
                                    <IconButton
                                        icon={
                                            <Feather
                                                name="x"
                                                size={16}
                                                color={theme.colors.textSecondary}
                                            />
                                        }
                                        accessibilityLabel="Dismiss this problem"
                                        onPress={voice.clearError}
                                    />
                                }
                            >
                                {describeError(voice.error).message}
                            </Banner>
                        ) : null}

                        {/* no_speech and a missing TTS voice are ordinary
                            outcomes of a working system, so they are a note,
                            not a red box. */}
                        {voice.notice ? (
                            <Banner
                                tone="info"
                                action={
                                    <IconButton
                                        icon={
                                            <Feather
                                                name="x"
                                                size={16}
                                                color={theme.colors.textSecondary}
                                            />
                                        }
                                        accessibilityLabel="Dismiss this note"
                                        onPress={voice.clearNotice}
                                    />
                                }
                            >
                                {voice.notice}
                            </Banner>
                        ) : null}

                        {!needsPermission ? (
                            <VoiceOrb
                                phase={voice.phase}
                                level={voice.level}
                                elapsed={voice.elapsed}
                                onPress={voice.pressPrimary}
                            />
                        ) : null}

                        {connected ? (
                            <Button
                                label="End"
                                variant="destructive"
                                size="lg"
                                fullWidth
                                icon={<Feather name="phone-off" size={18} color="#ffffff" />}
                                onPress={voice.hangUp}
                                accessibilityHint="Stops listening and closes the microphone"
                            />
                        ) : null}
                    </View>
                </>
            )}
        </Screen>
    );
}
