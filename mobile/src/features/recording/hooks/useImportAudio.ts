/**
 * Import an audio file into the outbox.
 *
 * Refuses locally what the server would refuse anyway — discovering a 400
 * after ten minutes of uploading on mobile data is not a rejection, it is a
 * betrayal — and moves the picker's copy out of the cache, which Android is
 * free to delete, so a queued import cannot evaporate.
 */

import * as DocumentPicker from 'expo-document-picker';
import { useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { formatBytes } from '@/shared/lib/bytes';
import { useToast } from '@/shared/ui';

import { isAcceptedAudioName, MAX_UPLOAD_BYTES } from '../api/upload';
import { newCaptureSettings } from '../model/capture';
import { moveIntoOutbox } from '../model/files';
import { useOutbox } from '../model/outbox';

export function useImportAudio(onQueued: (id: string) => void) {
    const t = useTranslation();
    const { toast } = useToast();
    const enqueue = useOutbox((state) => state.enqueue);
    const [importing, setImporting] = useState(false);

    const pick = async () => {
        // multer accepts anything with an `audio/*` MIME type or one of its
        // known extensions, so this is the widest honest filter.
        const result = await DocumentPicker.getDocumentAsync({
            type: ['audio/*'],
            copyToCacheDirectory: true,
            multiple: false,
        });
        const asset = result.canceled ? undefined : result.assets[0];
        if (!asset) return;
        if (!isAcceptedAudioName(asset.name) && !asset.mimeType?.startsWith('audio/')) {
            toast(t('mobile.recording.unsupported_audio', 'That file type cannot be transcribed'), 'error');
            return;
        }
        const size = asset.size ?? 0;
        if (size > MAX_UPLOAD_BYTES) {
            toast(`Too large — the limit is ${formatBytes(MAX_UPLOAD_BYTES)}`, 'error');
            return;
        }
        const stored = moveIntoOutbox(asset.uri, asset.name);
        const entry = await enqueue({
            uri: stored.uri,
            fileName: asset.name,
            mimeType: asset.mimeType || 'audio/mpeg',
            sizeBytes: stored.size || size,
            // An imported file's real duration is only known once the server
            // decodes it; 0 means the row shows no length rather than a made-up one.
            durationSeconds: 0,
            captureMode: 'upload',
            settings: newCaptureSettings(asset.name.replace(/\.[^.]+$/, '')),
        });
        onQueued(entry.id);
    };

    const importAudio = async () => {
        setImporting(true);
        try {
            await pick();
        } catch (err) {
            toast(describeError(err).message, 'error');
        } finally {
            setImporting(false);
        }
    };

    return { importing, importAudio };
}
