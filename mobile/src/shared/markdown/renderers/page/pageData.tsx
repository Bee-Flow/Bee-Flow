/**
 * A page's data elements, from the web's PageRenderer: a table (header row
 * on the tertiary surface, a rule between rows, sideways scroll when wide),
 * a stat (a big figure in its colour, its label, and a green ↑ or red ↓
 * change), a badge (a tinted pill) and a chart (a labelled bar per value,
 * drawn against the largest).
 */

import React from 'react';
import { StyleSheet, Text, View, type TextStyle, type ViewStyle } from 'react-native';

import { lookup } from '../lookup';
import type { ElementRenderer, PageCtx } from './pageElements';
import { cellText, chartBars, field, listOf, num, rowCells, type PageElement } from './pageModel';
import { BADGE_COLORS, CHANGE_DOWN, CHANGE_UP, STAT_COLORS } from './pagePalette';
import { GradientRule } from '../rich/GradientRule';
import { BRAND_GRADIENT } from '../rich/richPalette';
import { TextTable } from '../table/TextTable';

const styles = StyleSheet.create({ fill: { height: '100%', borderRadius: 999, overflow: 'hidden' } });

const ink = (color: string): TextStyle => ({ color });
const width = (value: string): ViewStyle => ({ width: value as ViewStyle['width'] });
const tinted = (tone: { bg: string } | null): ViewStyle | null => (tone ? { backgroundColor: tone.bg } : null);
const inked = (tone: { color: string } | null): TextStyle | null => (tone ? { color: tone.color } : null);
const barFill = (color: string): ViewStyle => ({ width: '100%', backgroundColor: color });

function Stat({ el, ctx }: { el: PageElement; ctx: PageCtx }) {
    const tone = lookup(STAT_COLORS, field(el, 'color')) ?? null;
    const change = num(el, 'change');
    return (
        <View style={[ctx.styles.stat, tinted(tone)]}>
            <Text style={[ctx.styles.statValue, inked(tone)]}>{field(el, 'value')}</Text>
            <Text style={ctx.styles.statLabel}>{field(el, 'label')}</Text>
            {change ? (
                <Text style={[ctx.styles.statChange, ink(change > 0 ? CHANGE_UP : CHANGE_DOWN)]}>
                    {`${change > 0 ? '↑' : '↓'} ${Math.abs(change)}%`}
                </Text>
            ) : null}
        </View>
    );
}

function Chart({ el, ctx }: { el: PageElement; ctx: PageCtx }) {
    const { bars, max } = chartBars(el);
    return (
        <View style={ctx.styles.tight}>
            {field(el, 'title') ? <Text style={ctx.styles.chartTitle}>{field(el, 'title')}</Text> : null}
            {bars.map((bar, i) => (
                <View key={i} style={ctx.styles.chartRow}>
                    <Text style={ctx.styles.chartLabel} numberOfLines={1}>
                        {bar.label}
                    </Text>
                    <View style={ctx.styles.chartTrack}>
                        <View style={[styles.fill, width(`${max > 0 ? (bar.value / max) * 100 : 0}%`)]}>
                            {bar.color ? (
                                <View style={[styles.fill, barFill(bar.color)]} />
                            ) : (
                                <GradientRule colors={BRAND_GRADIENT} height={22} fadeOut={false} />
                            )}
                        </View>
                    </View>
                    <Text style={ctx.styles.chartValue}>{bar.value}</Text>
                </View>
            ))}
        </View>
    );
}

export const DATA_ELEMENTS: Record<string, ElementRenderer> = {
    table: (el, _ctx, key) => (
        <TextTable
            key={key}
            header={listOf(el, 'columns').map(cellText)}
            rows={listOf(el, 'rows').map((row) => rowCells(row).map(cellText))}
        />
    ),
    stat: (el, ctx, key) => <Stat key={key} el={el} ctx={ctx} />,
    badge: (el, ctx, key) => {
        const tone = lookup(BADGE_COLORS, field(el, 'variant')) ?? null;
        return (
            <View key={key} style={[ctx.styles.badge, tinted(tone)]}>
                <Text style={[ctx.styles.badgeText, inked(tone)]}>{field(el, 'text')}</Text>
            </View>
        );
    },
    chart: (el, ctx, key) => <Chart key={key} el={el} ctx={ctx} />,
};
