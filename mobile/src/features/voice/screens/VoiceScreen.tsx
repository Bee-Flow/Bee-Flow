/**
 * Voice mode — a spoken conversation with Bee Flow.
 *
 * Arranged around the assumption that the user is NOT looking: one enormous
 * control in the thumb zone, a state word readable at arm's length, and the
 * written transcript above it for afterwards.
 *
 * Two gates first, because voice is a beta feature behind a capability AND a
 * configured Mistral key: GET /ai/voice/availability (`enabled:false` is a
 * server not set up yet, not an error) and the microphone permission, asked
 * for with an explanation first. The conversation lives only in the hook —
 * the server keeps none of it — so leaving ends the call.
 */

import { Stack, useRouter } from 'expo-router';
import React, { useEffect } from 'react';

import { useUserRefresh } from '@/shared/patterns';
import { EmptyState, ErrorState, ListSkeleton, Screen, ScreenHeader } from '@/shared/ui';

import { VoiceControls } from '../components/VoiceControls';
import { VoiceConversation } from '../components/VoiceConversation';
import { useVoiceAvailability } from '../hooks/queries';
import { useVoiceSession } from '../hooks/useVoiceSession';

export function VoiceScreen() {
    const router = useRouter();
    const availability = useVoiceAvailability();
    const refresh = useUserRefresh(() => availability.refetch());
    const voice = useVoiceSession();
    const connected = voice.phase !== 'offline';
    const { refreshPermission } = voice;

    useEffect(() => {
        // Mount-only, and a READ rather than a prompt: the screen has to know
        // whether to show the permission card before the user touches
        // anything, and asking cold burns Android's one good prompt.
        void refreshPermission();
    }, [refreshPermission]);

    const enabled = availability.data?.enabled ?? false;
    const needsPermission = !voice.permission.unknown && !voice.permission.granted;

    return (
        <Screen edges={['top', 'bottom']}>
            <Stack.Screen options={{ headerShown: false }} />
            <ScreenHeader
                title="Voice"
                subtitle={voice.session?.agentName ?? availability.data?.defaultModel ?? 'Spoken conversation'}
                // Leaving a live call has to end it, not just navigate away.
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
                    icon="MicOff"
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
                    <VoiceConversation
                        voice={voice}
                        needsPermission={needsPermission}
                        refreshing={refresh.refreshing}
                        onRefresh={refresh.onRefresh}
                    />
                    <VoiceControls voice={voice} needsPermission={needsPermission} />
                </>
            )}
        </Screen>
    );
}
