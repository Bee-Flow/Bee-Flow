/**
 * A page's accordion: each item a rounded panel on the tertiary surface
 * whose title opens and closes it (the web's <details>/<summary>), showing
 * its text or its child elements.
 */

import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { perTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, Text } from '@/shared/ui';

import type { ElementRenderer, PageCtx } from './pageElements';
import { childrenOf, field, isElement, listOf, type PageElement } from './pageModel';
import { useToggleSet } from '../rich/useToggleSet';

const sheet = perTheme((theme: Theme) =>
    StyleSheet.create({
        list: { gap: theme.spacing[2] },
        item: { borderRadius: theme.radii.md, backgroundColor: theme.colors.bgTertiary, overflow: 'hidden' },
        summary: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2], paddingVertical: 14, paddingHorizontal: theme.spacing[4] },
        body: { paddingHorizontal: theme.spacing[4], paddingBottom: theme.spacing[4], gap: theme.spacing[2] },
    }),
);

export function PageAccordion({ el, ctx, render }: { el: PageElement; ctx: PageCtx; render: ElementRenderer }) {
    const styles = useThemedStyles(sheet);
    const open = useToggleSet();
    return (
        <View style={styles.list}>
            {listOf(el, 'items')
                .filter(isElement)
                .map((item, i) => (
                    <View key={i} style={styles.item}>
                        <Pressable onPress={() => open.toggle(i)} accessibilityRole="button" accessibilityState={{ expanded: open.has(i) }} style={styles.summary}>
                            <Icon name={open.has(i) ? 'ChevronDown' : 'ChevronRight'} size={14} color={ctx.theme.colors.textTertiary} />
                            <Text variant="body" weight="medium">
                                {field(item, 'title')}
                            </Text>
                        </Pressable>
                        {open.has(i) ? (
                            <View style={styles.body}>
                                {field(item, 'content') ? (
                                    <Text style={ctx.styles.text}>{field(item, 'content')}</Text>
                                ) : (
                                    childrenOf(item).map((child, j) => render(child, ctx, `acc${i}.${j}`))
                                )}
                            </View>
                        ) : null}
                    </View>
                ))}
        </View>
    );
}
