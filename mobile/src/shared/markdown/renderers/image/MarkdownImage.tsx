/**
 * `![alt](url)` in an answer: the picture at its own width (never wider than
 * the message), with its own aspect ratio once it has loaded, rounded like
 * the web's `.markdown-content img`. A tap opens it full screen (a linked
 * picture follows its link instead, and opens full screen on a long press).
 *
 * Loaded through links.ts imageSource, so a server-stored picture carries the
 * session and a picture on someone else's host does not.
 */

import { Image } from 'expo-image';
import React, { useState } from 'react';
import { Pressable, Text, type ImageStyle } from 'react-native';

import { useMarkdownEnv } from '@/shared/markdown/env';

import { answerImage } from './answerImage';
import { ImageLightbox } from './ImageLightbox';

/** Before the size is known: a full-width placeholder; after: the picture's own shape. */
function imageBox(size: { width: number; height: number } | null): ImageStyle {
    if (!size || size.width <= 0 || size.height <= 0) return { width: '100%', height: 180 };
    return { width: '100%', maxWidth: size.width, aspectRatio: size.width / size.height };
}

export function MarkdownImage({
    href,
    alt,
    onPress,
}: {
    href: string;
    alt: string;
    /** A linked picture (`[![alt](src)](url)`) follows its link; a long press still opens it full screen. */
    onPress?: () => void;
}) {
    const { styles, t } = useMarkdownEnv();
    const [size, setSize] = useState<{ width: number; height: number } | null>(null);
    const [open, setOpen] = useState(false);
    const source = answerImage(href);

    if (!source) return alt ? <Text style={styles.imageAlt}>{alt}</Text> : null;
    const label = alt || t('chat.msg.lightbox_alt', 'Generated image');
    return (
        <>
            <Pressable
                onPress={onPress ?? (() => setOpen(true))}
                onLongPress={onPress ? () => setOpen(true) : undefined}
                accessibilityRole={onPress ? 'link' : 'imagebutton'}
                accessibilityLabel={label}
            >
                <Image
                    source={source}
                    style={[styles.image, imageBox(size)]}
                    contentFit="contain"
                    onLoad={(e) => setSize({ width: e.source.width, height: e.source.height })}
                />
            </Pressable>
            <ImageLightbox source={open ? source : null} alt={alt} onClose={() => setOpen(false)} />
        </>
    );
}
