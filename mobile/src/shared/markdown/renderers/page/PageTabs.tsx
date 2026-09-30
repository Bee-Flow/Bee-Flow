/**
 * A page's tabs: the web's strip of tab buttons over the first tab's content.
 * The web's buttons are drawn but never switch (only the first tab's
 * children are ever rendered); here a tap shows that tab, which is what the
 * strip promises.
 */

import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { perTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Text } from '@/shared/ui';

import type { ElementRenderer, PageCtx } from './pageElements';
import { childrenOf, field, listOf, isElement, type PageElement } from './pageModel';

const sheet = perTheme((theme: Theme) =>
    StyleSheet.create({
        wrap: { gap: theme.spacing[3] },
        strip: { gap: theme.spacing[2], paddingBottom: theme.spacing[2], borderBottomWidth: 2, borderBottomColor: theme.colors.borderSubtle },
        tab: { paddingVertical: theme.spacing[2], paddingHorizontal: theme.spacing[4], borderRadius: theme.radii.sm },
        active: { backgroundColor: theme.colors.bgTertiary },
        body: { gap: theme.spacing[3] },
    }),
);

export function PageTabs({ el, ctx, render }: { el: PageElement; ctx: PageCtx; render: ElementRenderer }) {
    const styles = useThemedStyles(sheet);
    const tabs = listOf(el, 'tabs').filter(isElement);
    const [active, setActive] = useState(0);
    const current = tabs[active] ?? tabs[0];
    return (
        <View style={styles.wrap}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip}>
                {tabs.map((tab, i) => (
                    <Pressable
                        key={i}
                        onPress={() => setActive(i)}
                        accessibilityRole="tab"
                        accessibilityState={{ selected: i === active }}
                        style={[styles.tab, i === active && styles.active]}
                    >
                        <Text variant="caption" weight="medium" tone={i === active ? 'primary' : 'tertiary'}>
                            {field(tab, 'label')}
                        </Text>
                    </Pressable>
                ))}
            </ScrollView>
            <View style={styles.body}>
                {current ? childrenOf(current).map((child, j) => render(child, ctx, `tab${active}.${j}`)) : null}
            </View>
        </View>
    );
}
