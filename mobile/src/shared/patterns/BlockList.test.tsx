/**
 * The block page, rendered: blocks keep their order, a card's rows become one
 * cell each with the card's edges on the first and last, and pull-to-refresh
 * reaches the caller.
 */

import { act, screen } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet, Text, type ViewStyle } from 'react-native';

import { pullToRefresh, renderWithProviders } from '@/shared/testing/renderWithProviders';

import { BlockList, cardRows, type Block } from './BlockList';

jest.setTimeout(30_000);

const text = (value: string): Block => ({ key: value, gap: 'section', render: () => <Text>{value}</Text> });
const rows = (key: string, labels: string[]) =>
    cardRows({ key, rows: labels, rowKey: (r) => r, render: (r) => <Text>{r}</Text> });

interface Node {
    parent: Node | null;
    props: { style?: unknown };
}

/** The card slice a row sits in: the nearest ancestor painted with the card's side edges. */
function sliceStyle(node: Node): ViewStyle {
    for (let at: Node | null = node; at; at = at.parent) {
        const style = StyleSheet.flatten(at.props.style as ViewStyle) ?? {};
        if (style.borderLeftWidth) return style;
    }
    throw new Error('not inside a card slice');
}

describe('cardRows', () => {
    it('makes one block per row, with the section gap only on the first', () => {
        const blocks = rows('runs', ['a', 'b', 'c']);
        expect(blocks.map((b) => b.key)).toEqual(['runs:a', 'runs:b', 'runs:c']);
        expect(blocks.map((b) => b.gap)).toEqual(['inner', 'none', 'none']);
    });

    it('takes the gap it is given for the first row', () => {
        const blocks = cardRows({ key: 'x', rows: [1], rowKey: String, render: () => <Text>1</Text>, gap: 'section' });
        expect(blocks[0]?.gap).toBe('section');
    });

    it('answers no blocks for no rows', () => {
        expect(rows('x', [])).toEqual([]);
    });
});

describe('BlockList', () => {
    it('draws every block, card rows included', async () => {
        const blocks = [text('Header'), ...rows('rows', ['one', 'two']), text('Footer')];
        await renderWithProviders(<BlockList blocks={blocks} refreshing={false} onRefresh={jest.fn()} />);
        for (const label of ['Header', 'one', 'two', 'Footer']) {
            expect(screen.getByText(label)).toBeTruthy();
        }
    });

    it('gives the card its top edge on the first row and its bottom edge on the last', async () => {
        await renderWithProviders(
            <BlockList blocks={rows('rows', ['first', 'middle', 'last'])} refreshing={false} onRefresh={jest.fn()} />,
        );
        const edges = ['first', 'middle', 'last'].map((label) => {
            const style = sliceStyle(screen.getByText(label));
            return [Boolean(style.borderTopWidth), Boolean(style.borderBottomWidth)];
        });
        expect(edges).toEqual([
            [true, false],
            [false, false],
            [false, true],
        ]);
    });

    it('hands pull-to-refresh to the caller', async () => {
        const onRefresh = jest.fn();
        await renderWithProviders(
            <BlockList testID="page" blocks={[text('Only')]} refreshing={false} onRefresh={onRefresh} />,
        );
        await act(async () => pullToRefresh(screen.getByTestId('page')));
        expect(onRefresh).toHaveBeenCalledTimes(1);
    });
});
