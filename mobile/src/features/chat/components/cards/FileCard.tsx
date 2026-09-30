/**
 * A file a tool built — a deck (the web's GeneratedFiles): Open when it also
 * lives in the Studio, Open in Nextcloud Office when it has a web address,
 * and the file itself, which on a phone goes to the share sheet ("Share or
 * save…", said as such) or, when it lives elsewhere, opens in the browser
 * (hooks/useFileHandOff).
 */

import { useRouter } from 'expo-router';
import React from 'react';

import { authHeaders } from '@/core/api/client';
import { getServerUrl } from '@/core/api/server';
import { useTranslation } from '@/core/i18n';
import { useFileHandOff } from '@/features/chat/hooks/useFileHandOff';
import { fileMeta, isDeck, mediaSource } from '@/features/chat/model/media';
import type { GeneratedFile } from '@/features/chat/model/types';
import { Button } from '@/shared/ui';

import { MediaCardFrame } from './MediaCardFrame';

export function FileCard({ file }: { file: GeneratedFile }) {
    const t = useTranslation();
    const router = useRouter();
    const { busy, openLink, actionFor } = useFileHandOff();
    const name = file.name || t('chat.files.file', 'File');
    const meta = fileMeta(file, (count) => t('chat.files.slides', '{count} slides', { count }));
    const source = file.url ? mediaSource({ url: file.url, mimeType: 'application/octet-stream' }, getServerUrl(), authHeaders()) : null;
    const action = actionFor(source, name);

    return (
        <MediaCardFrame icon={isDeck(file) ? 'Presentation' : 'FileText'} title={name} meta={meta}>
            {file.documentId ? (
                <Button label={t('chat.files.open', 'Open')} size="sm" onPress={() => router.push(`/documents/${file.documentId}`)} />
            ) : null}
            {file.webUrl ? (
                <Button label={t('chat.files.open_nextcloud', 'Open in Nextcloud Office')} size="sm" onPress={() => openLink(file.webUrl as string)} />
            ) : null}
            {action ? (
                <Button label={action.label} iconName={action.icon} size="sm" variant="secondary" loading={busy} onPress={action.onPress} />
            ) : null}
        </MediaCardFrame>
    );
}
