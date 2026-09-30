/**
 * A report's or a page's standalone picture: full width, at the height the model asked
 * for or its own aspect ratio, rounded, with the caption and credit centred
 * in italics beneath — and, like every picture in an answer, a tap opens it
 * full screen.
 */

import { Image } from 'expo-image';
import React, { useState } from 'react';
import { Pressable, StyleSheet, View, type ImageStyle } from 'react-native';

import { Text } from '@/shared/ui';

import { answerImage } from '../image/answerImage';
import { ImageLightbox } from '../image/ImageLightbox';

const styles = StyleSheet.create({
    figure: { gap: 8 },
    image: { borderRadius: 12 },
    caption: { fontStyle: 'italic' },
});

function frame(height: number | null, ratio: number | null): ImageStyle {
    if (height) return { width: '100%', height };
    return { width: '100%', aspectRatio: ratio ?? 16 / 9 };
}

export function RichImage({
    src,
    alt,
    caption,
    credit,
    height,
    fit,
}: {
    src: string;
    alt: string;
    caption: string;
    credit: string;
    height: number | null;
    fit: 'cover' | 'contain';
}) {
    const [ratio, setRatio] = useState<number | null>(null);
    const [open, setOpen] = useState(false);
    const source = answerImage(src);
    if (!source) return null;
    return (
        <View style={styles.figure}>
            <Pressable onPress={() => setOpen(true)} accessibilityRole="imagebutton" accessibilityLabel={alt || caption}>
                <Image
                    source={source}
                    style={[styles.image, frame(height, ratio)]}
                    contentFit={fit}
                    onLoad={(e) => e.source.height > 0 && setRatio(e.source.width / e.source.height)}
                />
            </Pressable>
            {caption || credit ? (
                <Text variant="caption" tone="tertiary" center style={styles.caption}>
                    {caption}
                    {credit ? ` — ${credit}` : ''}
                </Text>
            ) : null}
            <ImageLightbox source={open ? source : null} alt={alt || caption} onClose={() => setOpen(false)} />
        </View>
    );
}
