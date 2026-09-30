/**
 * The rows of the Flow tab: a node (what does the calling), an edge (what it
 * does, to what), and an external dependency (an id outside this Solution and
 * how many things lean on it).
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, KindTile, Text, kindOf, tonePair } from '@/shared/ui';

import type { GraphEdge, GraphExternal, GraphNode } from '../model/solution';

function verb(kind: string, t: TranslateFn): string {
    switch (kind) {
        case 'runs':
            return t('mobile.projects.edge_runs', 'runs');
        case 'calls':
            return t('mobile.projects.edge_calls', 'calls');
        case 'asks':
            return t('mobile.projects.edge_asks', 'asks');
        case 'uses':
            return t('mobile.projects.edge_uses', 'uses');
        case 'grounds':
            return t('mobile.projects.edge_grounds', 'reads');
        case 'feeds':
            return t('mobile.projects.edge_feeds', 'feeds');
        case 'triggers':
            return t('mobile.projects.edge_triggers', 'starts');
        default:
            return kind;
    }
}

/** A node's glyph: its kind's tile, or the shield of an approval step. */
function NodeGlyph({ type, size }: { type: string | undefined; size: number }) {
    const theme = useTheme();
    const kind = type ? kindOf(type) : null;
    if (kind) return <KindTile kind={kind} size={size} />;
    return <Icon name="ShieldCheck" size={size - 8} color={theme.colors.textTertiary} />;
}

export function NodeTitle({ node, fallback }: { node: GraphNode | null; fallback: string }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.line}>
            <NodeGlyph type={node?.type} size={24} />
            <Text variant="subheading" numberOfLines={2} style={styles.grow}>
                {node?.name || t('mobile.projects.node_unknown', 'Unknown')}
            </Text>
            {node ? null : (
                <Text variant="code" tone="tertiary">
                    {fallback}
                </Text>
            )}
        </View>
    );
}

export function EdgeRow({ edge, target }: { edge: GraphEdge; target: GraphNode | null }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const where = target ? target.name : edge.targetId || t('projects.flow_nothing_picked', 'nothing picked yet');
    return (
        <View style={[styles.line, styles.row]}>
            <Text variant="label" tone="tertiary">
                {verb(edge.kind, t).toUpperCase()}
            </Text>
            <Icon name="ArrowRight" size={12} color={styles.muted.color} />
            {target ? <NodeGlyph type={target.type} size={20} /> : null}
            <Text variant="body" tone={target ? 'secondary' : 'tertiary'} numberOfLines={1} style={styles.grow}>
                {where}
            </Text>
            {edge.problem ? <Icon name="TriangleAlert" size={14} color={styles.warning.color} /> : null}
        </View>
    );
}

export function ExternalRow({ external }: { external: GraphExternal }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={[styles.line, styles.row]}>
            <Text variant="code" tone="secondary" numberOfLines={1} style={styles.grow}>
                {external.id}
            </Text>
            <Text variant="caption" tone="tertiary">
                {`${t('projects.flow_used_by', 'used by')} ${external.referencedBy.length}`}
            </Text>
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    line: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm } satisfies ViewStyle,
    row: { paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing[2.5] } satisfies ViewStyle,
    grow: { flex: 1, minWidth: 0 },
    muted: { color: theme.colors.textTertiary },
    warning: { color: tonePair(theme.colors, 'warning').ink },
});
