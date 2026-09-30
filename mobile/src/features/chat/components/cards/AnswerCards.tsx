/**
 * What an answer prepared or made, in the web's places around the text:
 * drafts and maps (it renders them above the words), then images — unless
 * they are album art for audio — audio, video and files.
 */

import React from 'react';

import { GeneratedImages } from '@/features/chat/components/message/GeneratedImages';
import type { ChatMessage } from '@/features/chat/model/types';

import { AudioCard } from './AudioCard';
import { DraftCards } from './DraftCards';
import { FileCard } from './FileCard';
import { MapEmbedCard } from './MapEmbedCard';
import { VideoCard } from './VideoCard';

export function AnswerCards({ message }: { message: ChatMessage }) {
    const audio = message.audio ?? [];
    return (
        <>
            {message.drafts ? <DraftCards messageId={message.id} drafts={message.drafts} /> : null}
            {(message.maps ?? []).map((map, i) => (
                <MapEmbedCard key={`map-${i}`} map={map} />
            ))}
            {message.images?.length && audio.length === 0 ? <GeneratedImages images={message.images} /> : null}
            {audio.map((file, i) => (
                <AudioCard key={`audio-${i}`} audio={file} />
            ))}
            {(message.video ?? []).map((file, i) => (
                <VideoCard key={`video-${i}`} video={file} />
            ))}
            {(message.files ?? []).map((file, i) => (
                <FileCard key={`file-${i}`} file={file} />
            ))}
        </>
    );
}
