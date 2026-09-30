/**
 * A ```json-research report, natively: the web's ResearchRenderer block for
 * block — hero, Markdown, pictures, sources, callouts, figures, columns,
 * dividers and titled sections — in its card. A report with no hero gets its
 * title as a heading over the brand underline, as on the web.
 *
 * Columns: the web lays up to three side by side at any width; a phone gives
 * each column at least 150 points and wraps the rest underneath.
 */

import React, { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { useMarkdownEnv } from '@/shared/markdown/env';

import { ResearchCallout } from './ResearchCallout';
import { ResearchHero } from './ResearchHero';
import type { ResearchBlock as Block, ResearchReport } from './researchModel';
import { ResearchSources } from './ResearchSources';
import { ResearchStats } from './ResearchStats';
import { GradientRule } from '../rich/GradientRule';
import { RichFrame } from '../rich/RichFrame';
import { RichImage } from '../rich/RichImage';
import { RichTitle } from '../rich/RichTitle';

export { readResearch } from './researchModel';

const styles = StyleSheet.create({
    stack: { gap: 16 },
    columns: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 },
    column: { flexGrow: 1, flexBasis: 150, minWidth: 0, gap: 16 },
    divider: { marginVertical: 4 },
});

const DIVIDER = ['transparent', 'rgba(148, 163, 184, 0.35)', 'transparent'];

function ResearchPart({ block }: { block: Block }): ReactNode {
    const { Nested } = useMarkdownEnv();
    switch (block.type) {
        case 'hero':
            return <ResearchHero title={block.title} subtitle={block.subtitle} image={block.image} date={block.date} />;
        case 'markdown':
            return <Nested value={block.content} />;
        case 'image':
            return <RichImage {...block} />;
        case 'sources':
            return <ResearchSources items={block.items} />;
        case 'callout':
            return <ResearchCallout variant={block.variant} title={block.title} content={block.content} />;
        case 'stats':
            return <ResearchStats items={block.items} />;
        case 'columns':
            return (
                <View style={styles.columns}>
                    {block.children.map((child, i) => (
                        <View key={i} style={styles.column}>
                            <ResearchPart block={child} />
                        </View>
                    ))}
                </View>
            );
        case 'divider':
            return (
                <View style={styles.divider}>
                    <GradientRule colors={DIVIDER} height={1} fadeOut={false} />
                </View>
            );
        default:
            return (
                <View style={styles.stack}>
                    {block.title ? <RichTitle text={block.title} level="section" /> : null}
                    {block.children.map((child, i) => (
                        <ResearchPart key={i} block={child} />
                    ))}
                </View>
            );
    }
}

export function ResearchBlock({ data }: { data: ResearchReport }) {
    const hasHero = data.blocks.some((b) => b.type === 'hero');
    return (
        <RichFrame>
            {data.title && !hasHero ? <RichTitle text={data.title} level="report" /> : null}
            {data.blocks.map((block, i) => (
                <ResearchPart key={i} block={block.type === 'hero' && !block.title ? { ...block, title: data.title } : block} />
            ))}
        </RichFrame>
    );
}
