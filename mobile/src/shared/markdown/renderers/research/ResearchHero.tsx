/**
 * A research report's hero: the title in white over a deep navy gradient,
 * or over the report's picture darkened towards the bottom, with the
 * subtitle and date beneath it — the web's hero block.
 */

import { Image } from 'expo-image';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { Text } from '@/shared/ui';

import { answerImage } from '../image/answerImage';
import { GradientFill } from '../rich/GradientFill';
import { HERO_GRADIENT } from '../rich/richPalette';

const styles = StyleSheet.create({
    hero: { borderRadius: 16, overflow: 'hidden' },
    image: { width: '100%', height: 240 },
    over: { position: 'absolute', left: 0, right: 0, bottom: 0 },
    body: { padding: 20, gap: 6 },
    title: { color: '#fff', fontSize: 24, lineHeight: 29, fontWeight: '800' },
    subtitle: { color: 'rgba(255,255,255,0.75)' },
    date: { color: 'rgba(255,255,255,0.5)', marginTop: 4 },
});

const NAVY = HERO_GRADIENT.map((color) => ({ color }));
const SHADE = [
    { color: '#000', opacity: 0.85 },
    { color: '#000', opacity: 0.3 },
    { color: '#000', opacity: 0.1 },
];

export function ResearchHero({ title, subtitle, image: url, date }: { title: string; subtitle: string; image: string; date: string }) {
    const image = url ? answerImage(url) : null;
    const words = (
        <View style={[styles.body, image ? styles.over : null]}>
            <Text accessibilityRole="header" style={styles.title}>
                {title}
            </Text>
            {subtitle ? (
                <Text variant="body" style={styles.subtitle}>
                    {subtitle}
                </Text>
            ) : null}
            {date ? (
                <Text variant="caption" weight="medium" style={styles.date}>
                    {date}
                </Text>
            ) : null}
        </View>
    );
    if (!image) {
        return (
            <View style={styles.hero}>
                <GradientFill stops={NAVY} angle={135} />
                {words}
            </View>
        );
    }
    return (
        <View style={styles.hero}>
            <Image source={image} style={styles.image} contentFit="cover" accessibilityIgnoresInvertColors />
            <GradientFill stops={SHADE} angle={0} />
            {words}
        </View>
    );
}
