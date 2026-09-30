/**
 * What a node looks like on the canvas, by kind and zoom:
 *
 *   card       the outline's step card (outline/card), 240 wide, its ports on
 *              the edges and a branch port's name beside it (StepNodeBase);
 *   tile       below 60%: the same box in the family colour with the glyph
 *              (useZoomLod's "far" level — nothing to read at that size);
 *   container  an open loop: dashed in the loop colour, a header strip that
 *              says what one pass is ("LOOP · PER ITEM · 3 STEPS") and over
 *              what; its body is drawn inside it by the canvas;
 *   entry      "Each item", where the body begins: a pill, not a card, naming
 *              the item as the steps inside read it ("Loop item · row");
 *   note       a sticky note in its colour.
 *
 * Faces only draw; the node around them (CanvasNode) takes the touches.
 */

import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles } from '@/core/theme/ThemeProvider';
import { describeDataPath } from '@/features/flow-editor/bindings';
import { chipLabel } from '@/features/flow-editor/components/fields/bindingText';
import type { EdgeColorKey } from '@/features/flow-editor/model';
import { InlineMarkdown } from '@/shared/markdown';
import { Icon, Text } from '@/shared/ui';

import { localDot, makeCanvasStyles, pillAt, PORT_DOT, type CanvasStyles } from './canvasStyles';
import { EDGE_COLOR_HEX } from './edgeColors';
import type { SceneNode } from './scene';
import type { Lod } from './viewport';
import { CardBadges, CardBar, cardChromeStyles, CardText, CardTile } from '../outline/card';
import type { CardModel } from '../outline/cardModel';
import { makeOutlineStyles } from '../outline/outlineStyles';
import { rowWords } from '../outline/rowWords';

/** The rings where lines leave and arrive, and a branch port's name. */
function Ports({ node, named, styles }: { node: SceneNode; named: boolean; styles: CanvasStyles }) {
    const t = useTranslation();
    return (
        <>
            {node.targetDy !== null ? <View style={[styles.port, localDot(0, node.targetDy, PORT_DOT)]} /> : null}
            {node.ports.map((p) => (
                <React.Fragment key={p.id}>
                    <View style={[styles.port, localDot(node.width, p.dy, PORT_DOT)]} />
                    {named && p.text && p.tone ? (
                        <View style={[styles.portPill, styles.portPillTone[p.tone], pillAt(node.width - 24, p.dy)]}>
                            <Text variant="label" numberOfLines={1} style={styles.portWords[p.tone]}>
                                {rowWords(p.text, t)}
                            </Text>
                        </View>
                    ) : null}
                </React.Fragment>
            ))}
        </>
    );
}

function CardView({ node, card, styles }: { node: SceneNode; card: CardModel; styles: CanvasStyles }) {
    const outline = useThemedStyles(makeOutlineStyles);
    return (
        <>
            <View style={[...cardChromeStyles(card, outline), styles.card, styles.fill]}>
                <CardBar card={card} styles={outline} />
                <CardTile card={card} styles={outline} />
                <CardText card={card} styles={outline} />
            </View>
            <View style={styles.badgeSlot}>
                <CardBadges card={card} styles={outline} />
            </View>
            <Ports node={node} named={node.ports.length > 1} styles={styles} />
        </>
    );
}

function TileView({ card, styles }: { card: CardModel; styles: CanvasStyles }) {
    const key = card.family ?? 'none';
    return (
        <View style={[styles.fill, styles.tile, styles.tileColor[key]]}>
            <Icon name={card.icon} size={30} color={styles.tileGlyph[key].color} />
        </View>
    );
}

/** What an open loop works through, how many at a time and its cap — the web's ExpandedLoop line. */
function loopOverLine(node: SceneNode, card: CardModel, t: ReturnType<typeof useTranslation>): string {
    const step = node.node;
    const item = typeof step.itemVar === 'string' && step.itemVar ? step.itemVar : 'item';
    // The list as the outline's loop card names it: the step's name and the field, never its id.
    const list = card.list || '—';
    const max = typeof step.maxIterations === 'number' ? step.maxIterations : 100;
    const batch = Math.max(1, Number(step.batchSize) || 1);
    return batch > 1
        ? t('routines.canvas.loop_over_summary_batched', 'over {list} · as loop.{item} · ×{batch} · ≤{max}', { list, item, batch, max })
        : t('routines.canvas.loop_over_summary', 'over {list} · as loop.{item} · ≤{max}', { list, item, max });
}

function LoopBox({ node, card, styles }: { node: SceneNode; card: CardModel; styles: CanvasStyles }) {
    const t = useTranslation();
    const step = node.node;
    const item = typeof step.itemVar === 'string' && step.itemVar ? step.itemVar : 'item';
    const count = node.bodyCount;
    const steps = count === 1
        ? t('routines.canvas.loop_body_step', '{n} step', { n: count })
        : t('routines.canvas.loop_body_step_plural', '{n} steps', { n: count });
    return (
        <View style={[styles.fill, styles.container]}>
            <View style={styles.containerHeader}>
                <Icon name="Repeat" size={14} color={styles.loopGlyph.color} />
                <View style={styles.headerText}>
                    <Text variant="label" weight="semibold" numberOfLines={1} style={styles.loopWords}>
                        {`${card.kicker} · ${t('routines.canvas.loop_per_item', 'per {item}', { item })} · ${steps}`}
                    </Text>
                    <Text variant="caption" weight="semibold" numberOfLines={1}>
                        {card.name}
                    </Text>
                    <Text variant="label" tone="tertiary" numberOfLines={1}>
                        {loopOverLine(node, card, t)}
                    </Text>
                </View>
            </View>
            <Ports node={node} named={false} styles={styles} />
        </View>
    );
}

function EntryPill({ node, styles }: { node: SceneNode; styles: CanvasStyles }) {
    const t = useTranslation();
    const batch = Math.max(1, Number(node.node.batchSize) || 1);
    const item = typeof node.node.itemVar === 'string' ? node.node.itemVar : 'item';
    return (
        <>
            <View style={[styles.fill, styles.entry]}>
                <Icon name="CornerDownRight" size={14} color={styles.loopGlyph.color} />
                <View style={styles.headerText}>
                    <Text variant="caption" weight="semibold" numberOfLines={1}>
                        {batch > 1 ? t('routines.canvas.loop_each_batch', 'Each batch of {n}', { n: batch }) : t('routines.canvas.loop_each_item', 'Each item')}
                    </Text>
                    <Text variant="label" tone="secondary" numberOfLines={1}>
                        {chipLabel(describeDataPath(`loop.${item}`))}
                    </Text>
                </View>
            </View>
            <Ports node={node} named={false} styles={styles} />
        </>
    );
}

function NoteView({ node, styles }: { node: SceneNode; styles: CanvasStyles }) {
    const t = useTranslation();
    const color = (typeof node.node.color === 'string' && node.node.color in EDGE_COLOR_HEX ? node.node.color : 'amber') as EdgeColorKey;
    const text = typeof node.node.text === 'string' ? node.node.text : '';
    return (
        <View style={[styles.fill, styles.note, styles.noteColor[color]]}>
            {text ? (
                <InlineMarkdown value={text} variant="caption" numberOfLines={8} />
            ) : (
                <Text variant="caption" tone="tertiary" numberOfLines={8}>
                    {t('mobile.flow.canvas.note_empty', 'An empty note — tap to write it')}
                </Text>
            )}
        </View>
    );
}

/** The face for one node at one zoom level. */
export function NodeFace({ node, card, lod }: { node: SceneNode; card: CardModel | null; lod: Lod }) {
    const styles = useThemedStyles(makeCanvasStyles);
    if (node.kind === 'note') return <NoteView node={node} styles={styles} />;
    if (node.kind === 'entry') return <EntryPill node={node} styles={styles} />;
    if (!card) return null;
    if (node.kind === 'container') return <LoopBox node={node} card={card} styles={styles} />;
    if (lod === 'tile') return <TileView card={card} styles={styles} />;
    return <CardView node={node} card={card} styles={styles} />;
}
