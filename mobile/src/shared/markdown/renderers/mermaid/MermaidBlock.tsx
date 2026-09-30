/**
 * A ```mermaid flowchart, drawn natively (flowchartParser → flowchartLayout →
 * FlowchartSvg) in the web's card: the tertiary surface, a subtle border, the
 * diagram centred. It is scaled to the message's width, but never below half
 * size — a wide diagram then scrolls sideways instead of shrinking into
 * unreadable print. "Expand" (always shown: a phone has no hover) and a tap
 * on the card open it full screen, where it zooms; the web's "Download SVG"
 * becomes "Copy code", the Mermaid source.
 */

import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';

import { perTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useMarkdownEnv } from '@/shared/markdown/env';
import { Icon, Text } from '@/shared/ui';

import { layoutFlowchart } from './flowchartLayout';
import type { Flowchart } from './flowchartParser';
import { FlowchartSvg } from './FlowchartSvg';
import { FullScreenViewer } from '../viewer/FullScreenViewer';

export { readFlowchart } from './flowchartParser';

const MIN_SCALE = 0.5;

const sheet = perTheme((theme: Theme) =>
    StyleSheet.create({
        card: {
            borderRadius: theme.radii.md,
            borderWidth: 1,
            borderColor: theme.colors.borderSubtle,
            backgroundColor: theme.colors.bgTertiary,
            paddingTop: theme.spacing[8],
            paddingBottom: theme.spacing[4],
            paddingHorizontal: theme.spacing[3],
            overflow: 'hidden',
        },
        center: { flexGrow: 1, alignItems: 'center' },
        expand: {
            position: 'absolute',
            top: theme.spacing[2],
            right: theme.spacing[2],
            flexDirection: 'row',
            alignItems: 'center',
            gap: 5,
            paddingVertical: 5,
            paddingHorizontal: 10,
            borderRadius: theme.radii.sm,
            borderWidth: 1,
            borderColor: 'rgba(255,255,255,0.08)',
            backgroundColor: 'rgba(255,255,255,0.06)',
        },
    }),
);

export function MermaidBlock({ chart, source }: { chart: Flowchart; source: string }) {
    const styles = useThemedStyles(sheet);
    const { t, theme, copy } = useMarkdownEnv();
    const screen = useWindowDimensions();
    const [width, setWidth] = useState(0);
    const [full, setFull] = useState(false);
    const layout = layoutFlowchart(chart);
    const scale = Math.max(MIN_SCALE, Math.min(1, width / Math.max(1, layout.width)));
    const fullScale = Math.min((screen.width - 24) / Math.max(1, layout.width), (screen.height - 160) / Math.max(1, layout.height));
    const label = t('notebooks.diagram_alt', 'Diagram');

    return (
        <>
            <Pressable onPress={() => setFull(true)} accessibilityRole="imagebutton" accessibilityLabel={label} style={styles.card}>
                <View onLayout={(e) => setWidth(Math.floor(e.nativeEvent.layout.width))}>
                    {width > 0 ? (
                        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.center}>
                            <FlowchartSvg layout={layout} width={layout.width * scale} height={layout.height * scale} label={label} />
                        </ScrollView>
                    ) : null}
                </View>
                <View style={styles.expand} pointerEvents="none">
                    <Icon name="Maximize2" size={13} color={theme.colors.textMuted} />
                    <Text variant="label" tone="tertiary">
                        {t('nc_scope.expand', 'Expand')}
                    </Text>
                </View>
            </Pressable>
            <FullScreenViewer
                visible={full}
                title={`📊 ${t('mobile.markdown.diagram_full_view', 'Diagram — Full View')}`}
                actions={[{ icon: 'Copy', label: t('notebooks.mermaid_copy_code', 'Copy code'), onPress: () => copy(source) }]}
                onClose={() => setFull(false)}
                closeLabel={t('common.close', 'Close')}
            >
                <FlowchartSvg layout={layout} width={layout.width * fullScale} height={layout.height * fullScale} label={label} />
            </FullScreenViewer>
        </>
    );
}
