/**
 * A page element to React Native — the web PageRenderer's `renderElement`,
 * as a table from element type to renderer. Layout and content live here;
 * the data elements (table, stat, badge, chart) are in pageData.tsx, and the
 * ones that keep state (button, tabs, accordion) are components of their own.
 *
 * Grids and rows wrap: a phone cannot hold the web's three-across grid at a
 * readable size, so a cell keeps a minimum width and the rest flow beneath.
 */

import React, { type ReactNode } from 'react';
import { Text, View } from 'react-native';

import type { TranslateFn } from '@/core/i18n';
import type { Theme } from '@/core/theme/ThemeProvider';

import { lookup } from '../lookup';
import { PageAccordion } from './PageAccordion';
import { PageButton } from './PageButton';
import { DATA_ELEMENTS } from './pageData';
import { childrenOf, field, isElement, listOf, num, type ButtonOverlay, type PageElement } from './pageModel';
import { gapOf, gridCell, pageHeading, rowLayout, type PageStyles } from './pageStyles';
import { PageTabs } from './PageTabs';
import { GradientRule } from '../rich/GradientRule';
import { RichImage } from '../rich/RichImage';
import { CARD_ACCENT } from '../rich/richPalette';
import { RichTitle } from '../rich/RichTitle';

export interface PageCtx {
    styles: PageStyles;
    theme: Theme;
    t: TranslateFn;
    onButton: (overlay: ButtonOverlay) => void;
}

export type ElementRenderer = (el: PageElement, ctx: PageCtx, key: string) => ReactNode;

export function renderChildren(el: PageElement, ctx: PageCtx, key: string): ReactNode[] {
    return childrenOf(el).map((child, i) => renderElement(child, ctx, `${key}.${i}`));
}

interface ListEntry {
    item: unknown;
    marker: string;
    key: string;
}

function listItem({ item, marker, key }: ListEntry, ctx: PageCtx): ReactNode {
    const { styles } = ctx;
    return (
        <View key={key} style={styles.listItem}>
            <Text style={styles.listMarker}>{marker}</Text>
            <View style={styles.listBody}>
                {isElement(item) ? renderElement(item, ctx, key) : <Text style={styles.text}>{String(item)}</Text>}
            </View>
        </View>
    );
}

const LAYOUT: Record<string, ElementRenderer> = {
    page: (el, ctx, key) => (
        <View key={key} style={ctx.styles.column}>
            {field(el, 'title') ? <RichTitle text={field(el, 'title')} level="report" /> : null}
            {renderChildren(el, ctx, key)}
        </View>
    ),
    grid: (el, ctx, key) => (
        <View key={key} style={[ctx.styles.wrap, gapOf(num(el, 'gap'))]}>
            {childrenOf(el).map((child, i) => (
                <View key={i} style={gridCell(num(el, 'columns') ?? 2)}>
                    {renderElement(child, ctx, `${key}.${i}`)}
                </View>
            ))}
        </View>
    ),
    row: (el, ctx, key) => (
        <View key={key} style={[ctx.styles.wrap, rowLayout(field(el, 'align'), field(el, 'justify'), num(el, 'gap'))]}>
            {renderChildren(el, ctx, key)}
        </View>
    ),
    section: (el, ctx, key) => (
        <View key={key} style={ctx.styles.column}>
            {field(el, 'title') ? <Text style={ctx.styles.sectionTitle}>{field(el, 'title')}</Text> : null}
            {renderChildren(el, ctx, key)}
        </View>
    ),
    card: (el, ctx, key) => (
        <View key={key} style={ctx.styles.card}>
            <View style={ctx.styles.cardBar}>
                <GradientRule colors={CARD_ACCENT} height={3} fadeOut={false} />
            </View>
            {field(el, 'title') ? <Text style={ctx.styles.cardTitle}>{field(el, 'title')}</Text> : null}
            {renderChildren(el, ctx, key)}
        </View>
    ),
    heading: (el, ctx, key) => (
        <Text key={key} accessibilityRole="header" style={[ctx.styles.heading, pageHeading(num(el, 'level'))]}>
            {field(el, 'text')}
        </Text>
    ),
    text: (el, ctx, key) => (
        <Text key={key} selectable style={ctx.styles.text}>
            {field(el, 'text') || field(el, 'content')}
        </Text>
    ),
    image: (el, _ctx, key) =>
        field(el, 'src') ? (
            <RichImage
                key={key}
                src={field(el, 'src')}
                alt={field(el, 'alt')}
                caption=""
                credit=""
                height={num(el, 'height')}
                fit={field(el, 'fit') === 'contain' ? 'contain' : 'cover'}
            />
        ) : null,
    list: (el, ctx, key) => (
        <View key={key} style={ctx.styles.tight}>
            {listOf(el, 'items').map((item, i) =>
                listItem({ item, marker: el.ordered === true ? `${i + 1}.` : '•', key: `${key}.${i}` }, ctx),
            )}
        </View>
    ),
    divider: (_el, ctx, key) => <View key={key} style={ctx.styles.divider} />,
    button: (el, ctx, key) => <PageButton key={key} el={el} ctx={ctx} />,
    tabs: (el, ctx, key) => <PageTabs key={key} el={el} ctx={ctx} render={renderElement} />,
    accordion: (el, ctx, key) => <PageAccordion key={key} el={el} ctx={ctx} render={renderElement} />,
};
LAYOUT.columns = LAYOUT.row as ElementRenderer;
LAYOUT.paragraph = LAYOUT.text as ElementRenderer;

export function renderElement(el: PageElement, ctx: PageCtx, key: string): ReactNode {
    const type = typeof el.type === 'string' ? el.type : '';
    const render = lookup(LAYOUT, type) ?? lookup(DATA_ELEMENTS, type);
    if (render) return render(el, ctx, key);
    // The web's default: an unknown element with words shows them.
    const words = field(el, 'text') || field(el, 'content');
    return words ? (
        <Text key={key} style={ctx.styles.text}>
            {words}
        </Text>
    ) : null;
}
