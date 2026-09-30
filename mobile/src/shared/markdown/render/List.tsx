/**
 * A bullet or numbered list, with the web's markers per nesting level
 * (listMarkers.ts), a numbered list's own start number, and GFM task items
 * drawn with a checkbox instead of a marker, as the web's task lists are.
 *
 * An item's content is rendered by the block renderer it is handed, so a
 * list holds paragraphs, code, quotes and further lists like any block.
 */

import type { Token, Tokens } from 'marked';
import React, { type ReactNode } from 'react';
import { Text, View, type TextStyle } from 'react-native';

import { Icon } from '@/shared/ui';

import type { RenderCtx } from './ctx';
import { bulletMarker, markerWidth, numberMarker } from './listMarkers';

export type RenderBlocks = (tokens: readonly Token[], ctx: RenderCtx, key: string) => ReactNode[];

function widthStyle(width: number): TextStyle {
    return { width };
}

function startOf(list: Tokens.List): number {
    const n = Number(list.start);
    return Number.isInteger(n) && n >= 0 ? n : 1;
}

export function List({ token, ctx, renderBlocks }: { token: Tokens.List; ctx: RenderCtx; renderBlocks: RenderBlocks }) {
    const { styles, theme } = ctx.env;
    const lists = token.ordered ? { ...ctx.lists, ol: ctx.lists.ol + 1 } : { ...ctx.lists, ul: ctx.lists.ul + 1 };
    const inner: RenderCtx = { ...ctx, lists };
    const first = startOf(token);
    const markers = token.items.map((_, i) =>
        token.ordered ? numberMarker(first + i, lists.ol) : bulletMarker(lists.ul),
    );
    const width = widthStyle(markerWidth(markers, !token.ordered));

    return (
        <View style={styles.list} accessibilityRole="list">
            {token.items.map((item, i) => (
                <View key={i} style={styles.item}>
                    {item.task ? (
                        <View style={styles.check}>
                            <Icon
                                name={item.checked ? 'SquareCheckBig' : 'Square'}
                                size={16}
                                color={item.checked ? theme.colors.accentPrimary : theme.colors.textTertiary}
                            />
                        </View>
                    ) : (
                        <Text style={[styles.marker, width]}>{markers[i]}</Text>
                    )}
                    <View style={styles.itemBody}>{renderBlocks(item.tokens, inner, `li${i}`)}</View>
                </View>
            ))}
        </View>
    );
}
