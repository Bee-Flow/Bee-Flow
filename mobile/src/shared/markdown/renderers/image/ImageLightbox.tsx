/**
 * A picture opened full screen: the web's ImageLightbox (Download and Close
 * over the image), plus Share — on a phone, the share sheet is where "send
 * this to someone" and "put it in Drive" live — and pinch to zoom.
 *
 * Exported through the Markdown index so the chat's generated images can open
 * the same viewer as an image inside an answer.
 */

import { Image } from 'expo-image';
import React, { useState } from 'react';
import { StyleSheet } from 'react-native';

import { useTranslation } from '@/core/i18n';
import type { ImageSource } from '@/shared/markdown/links';

import { saveImage, shareImage, type ImageActionResult } from './imageFile';
import { FullScreenViewer } from '../viewer/FullScreenViewer';

const styles = StyleSheet.create({ image: { width: '100%', height: '100%' } });

export function ImageLightbox({
    source,
    alt,
    onClose,
}: {
    /** The picture to show; null keeps the viewer closed. */
    source: ImageSource | null;
    alt?: string;
    onClose: () => void;
}) {
    const t = useTranslation();
    const [status, setStatus] = useState<string | null>(null);
    const unavailable = t('mobile.markdown.image_unavailable', 'This picture has not finished loading yet.');

    const run = (action: (uri: string) => Promise<ImageActionResult>, done: string | null) => () => {
        if (!source) return;
        setStatus(null);
        action(source.uri)
            .then((result) => setStatus(result === 'done' ? done : result === 'unavailable' ? unavailable : null))
            .catch(() => setStatus(t('mobile.markdown.image_failed', 'That did not work. Try again.')));
    };

    const close = () => {
        setStatus(null);
        onClose();
    };

    return (
        <FullScreenViewer
            visible={source !== null}
            actions={[
                { icon: 'Download', label: t('chat.download', 'Download'), onPress: run(saveImage, t('mobile.markdown.image_saved', 'Saved to the folder you picked.')) },
                { icon: 'Share2', label: t('mobile.markdown.share_image', 'Share image'), onPress: run(shareImage, null), iconOnly: true },
            ]}
            status={status}
            onClose={close}
            closeLabel={t('chat.msg.lightbox_close', 'Close image')}
        >
            {source ? (
                <Image
                    source={source}
                    style={styles.image}
                    contentFit="contain"
                    accessibilityLabel={alt || t('chat.msg.lightbox_alt', 'Generated image')}
                />
            ) : null}
        </FullScreenViewer>
    );
}
