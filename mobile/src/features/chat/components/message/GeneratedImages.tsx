/**
 * Images the model generated. Loaded by URL through expo-image once the
 * server stored them; the source is resolved per render rather than stored,
 * because the server URL and the SSO token can both change under a mounted
 * transcript. A tap opens the picture full screen — the same viewer as an
 * image inside an answer — with Download, Share and pinch to zoom.
 */

import { Image } from 'expo-image';
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';

import { authHeaders } from '@/core/api/client';
import { getServerUrl } from '@/core/api/server';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { ChatImage } from '@/features/chat/model/types';
import { ImageLightbox, imageSource, type ImageSource } from '@/shared/markdown';


const makeStyles = (theme: Theme) => ({
    list: { gap: theme.spacing.sm, marginTop: theme.spacing.sm },
    image: {
        width: '100%' as const,
        aspectRatio: 1,
        borderRadius: theme.radii.md,
        backgroundColor: theme.colors.bgTertiary,
    },
});

export function GeneratedImages({ images }: { images: ChatImage[] }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [open, setOpen] = useState<ImageSource | null>(null);
    const alt = t('chat.msg.lightbox_alt', 'Generated image');
    return (
        <View style={styles.list}>
            {images.map((img, i) => {
                const source = imageSource(img, getServerUrl(), authHeaders());
                return source ? (
                    <Pressable key={i} onPress={() => setOpen(source)} accessibilityRole="imagebutton" accessibilityLabel={alt}>
                        <Image source={source} style={styles.image} contentFit="contain" />
                    </Pressable>
                ) : null;
            })}
            <ImageLightbox source={open} alt={alt} onClose={() => setOpen(null)} />
        </View>
    );
}
