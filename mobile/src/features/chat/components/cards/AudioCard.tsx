/**
 * Generated audio — music, speech, a sound effect (the web's GeneratedAudio):
 * played in place with expo-audio. Nothing loads until Play: a transcript
 * with ten songs in it must not open ten players on arrival. The session's
 * headers go to this server's files only (media.ts).
 */

import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import React, { useEffect, useRef, useState } from 'react';

import { authHeaders } from '@/core/api/client';
import { getServerUrl } from '@/core/api/server';
import { useTranslation } from '@/core/i18n';
import { formatClock, mediaSource } from '@/features/chat/model/media';
import type { AudioFile } from '@/features/chat/model/types';
import { Button } from '@/shared/ui';

import { MediaCardFrame } from './MediaCardFrame';

export function AudioCard({ audio }: { audio: AudioFile }) {
    const t = useTranslation();
    const [armed, setArmed] = useState(false);
    const source = armed ? mediaSource(audio, getServerUrl(), authHeaders()) : null;
    const player = useAudioPlayer(source, { updateInterval: 500 });
    const status = useAudioPlayerStatus(player);
    const playing = Boolean(status.playing);
    const started = useRef(false);

    // The first Play arms the source, which makes a new player; it starts
    // once that player has loaded the file.
    useEffect(() => {
        if (!armed || !status.isLoaded || started.current) return;
        started.current = true;
        player.play();
    }, [armed, status.isLoaded, player]);

    const toggle = () => {
        if (!armed) setArmed(true);
        else if (playing) player.pause();
        else player.play();
    };

    const meta = status.duration ? `${formatClock(status.currentTime ?? 0)} / ${formatClock(status.duration)}` : undefined;
    return (
        <MediaCardFrame icon="Volume2" title={t('chat.media.audio_title', 'AI Generated Audio')} meta={meta}>
            <Button
                label={playing ? t('mobile.recording.pause', 'Pause') : t('mobile.recording.play', 'Play')}
                iconName={playing ? 'Pause' : 'Play'}
                size="sm"
                loading={armed && !status.isLoaded}
                onPress={toggle}
            />
        </MediaCardFrame>
    );
}
