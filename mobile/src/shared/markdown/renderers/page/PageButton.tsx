/**
 * A page button in the web's variant gradients (primary violet → indigo,
 * success, danger, warning; secondary on the tertiary surface). A tap opens
 * the overlay the web opens: the button's title, its description and a link
 * when it carries one.
 */

import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/shared/ui';

import { lookup } from '../lookup';
import type { PageCtx } from './pageElements';
import { buttonOverlay, field, type PageElement } from './pageModel';
import { BUTTON_GRADIENTS } from './pagePalette';
import { GradientFill } from '../rich/GradientFill';

const styles = StyleSheet.create({
    button: { alignSelf: 'flex-start', paddingVertical: 10, paddingHorizontal: 20, borderRadius: 10, overflow: 'hidden' },
    pressed: { opacity: 0.85 },
    label: { color: '#fff', fontSize: 14, fontWeight: '500' },
});

export function PageButton({ el, ctx }: { el: PageElement; ctx: PageCtx }) {
    const variant = field(el, 'variant');
    const found = lookup(BUTTON_GRADIENTS, variant);
    const gradient = found === undefined ? BUTTON_GRADIENTS.primary : found;
    const secondary = gradient === null;
    return (
        <Pressable
            onPress={() => ctx.onButton(buttonOverlay(el))}
            accessibilityRole="button"
            style={({ pressed }) => [styles.button, secondary && ctx.styles.secondaryButton, pressed && styles.pressed]}
        >
            {gradient ? <GradientFill stops={gradient.map((color) => ({ color }))} angle={135} /> : null}
            <View>
                <Text style={[styles.label, secondary && ctx.styles.heading]}>{field(el, 'text') || field(el, 'label')}</Text>
            </View>
        </Pressable>
    );
}
