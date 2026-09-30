/**
 * A generated video (the web's GeneratedVideos). This app has no in-app video
 * player (no expo-video in the build), so the card hands the clip to the
 * phone: this workspace's file is downloaded with the session and offered to
 * the share sheet — save it, send it, or give it to an app that plays it —
 * under a label that says so, and a link elsewhere opens in the browser,
 * without the session's headers (hooks/useFileHandOff).
 */

import React from 'react';

import { authHeaders } from '@/core/api/client';
import { getServerUrl } from '@/core/api/server';
import { useTranslation } from '@/core/i18n';
import { useFileHandOff } from '@/features/chat/hooks/useFileHandOff';
import { mediaFileName, mediaSource } from '@/features/chat/model/media';
import type { VideoFile } from '@/features/chat/model/types';
import { Button } from '@/shared/ui';

import { MediaCardFrame } from './MediaCardFrame';

export function VideoCard({ video }: { video: VideoFile }) {
    const t = useTranslation();
    const { busy, actionFor } = useFileHandOff();
    const source = mediaSource(video, getServerUrl(), authHeaders());
    const action = actionFor(source, mediaFileName(video.url, video.mimeType, 'video'), video.mimeType);

    return (
        <MediaCardFrame icon="Video" title={t('chat.media.video_title', 'AI Generated Video')} meta={video.mimeType}>
            {action ? <Button label={action.label} iconName={action.icon} size="sm" loading={busy} onPress={action.onPress} /> : null}
        </MediaCardFrame>
    );
}
