/** One planned block of an app screen, drawn with the phone's own primitives. */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, Card, Divider, Text } from '@/shared/ui';

import { ActionRunner } from './ActionRunner';
import { FormCard } from './FormCard';
import { InlineText } from './InlineText';
import type { AppBlock } from '../model/appDefinition';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        tight: { gap: 2 },
        rule: { marginTop: theme.spacing.sm },
    });

/** callout tones are info/success/warning/danger; Banner speaks four too. */
function calloutTone(tone: string): 'info' | 'success' | 'warning' | 'error' {
    if (tone === 'success') return 'success';
    if (tone === 'warning') return 'warning';
    if (tone === 'danger') return 'error';
    return 'info';
}

function PageHeader({ block }: { block: Extract<AppBlock, { kind: 'page_header' }> }) {
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.tight}>
            <Text variant="title" accessibilityRole="header">
                {block.title}
            </Text>
            {block.subtitle ? (
                <Text variant="caption" tone="tertiary">
                    <InlineText text={block.subtitle} />
                </Text>
            ) : null}
            {block.divider ? (
                <View style={styles.rule}>
                    <Divider />
                </View>
            ) : null}
        </View>
    );
}

function Callout({ block }: { block: Extract<AppBlock, { kind: 'callout' }> }) {
    const styles = useThemedStyles(makeStyles);
    return (
        <Banner tone={calloutTone(block.tone)}>
            <View style={styles.tight}>
                {block.title ? (
                    <Text variant="caption" weight="semibold">
                        {block.title}
                    </Text>
                ) : null}
                <Text variant="caption">
                    <InlineText text={block.body} />
                </Text>
            </View>
        </Banner>
    );
}

/** `draft`: the app on screen is the owner's draft, so its buttons run the draft (ActionRunner). */
export function BlockView({ appId, draft = false, block }: { appId: string; draft?: boolean; block: AppBlock }) {
    const theme = useTheme();

    switch (block.kind) {
        case 'page_header':
            return <PageHeader block={block} />;
        case 'spacer':
            // Empty vertical space, which is what AppSpacer draws. This used to
            // be planned as a divider, so a spacer put a visible hairline rule
            // where the app intended a gap.
            return <View style={{ height: theme.spacing.md * Math.max(1, block.steps) }} />;
        case 'heading':
            return (
                <Text variant={block.level === 1 ? 'title' : 'heading'} accessibilityRole="header">
                    {block.text}
                </Text>
            );
        case 'text':
            return (
                <Text variant="body" tone={block.muted ? 'tertiary' : 'primary'}>
                    <InlineText text={block.text} />
                </Text>
            );
        case 'callout':
            return <Callout block={block} />;
        case 'stat':
            return (
                <Card>
                    <Text variant="label" tone="tertiary">
                        {block.label.toUpperCase()}
                    </Text>
                    <Text variant="title">{block.value}</Text>
                </Card>
            );
        case 'divider':
            return <Divider />;
        case 'button':
            return (
                <Card>
                    <ActionRunner appId={appId} draft={draft} action={block.action} label={block.action.label} collect={() => ({})} />
                </Card>
            );
        case 'form':
            return <FormCard appId={appId} draft={draft} block={block} />;
        default:
            return <View style={{ height: theme.spacing.xs }} />;
    }
}
