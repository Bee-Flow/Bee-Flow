import { screen } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { IconTile } from './IconTile';

jest.setTimeout(30_000);

function tileBackground(testID: string): unknown {
    const tile = screen.getByTestId(testID).children[0] as unknown as { props: { style: StyleProp<ViewStyle> } };
    return StyleSheet.flatten(tile.props.style)?.backgroundColor;
}

describe('IconTile', () => {
    it('paints a coloured tile as a tint of its colour, and a plain one on the tertiary background', async () => {
        await renderWithProviders(
            <>
                <View testID="coloured"><IconTile name="Shield" color="#0ea5e9" /></View>
                <View testID="plain"><IconTile name="Shield" /></View>
            </>,
        );
        const coloured = tileBackground('coloured');
        const plain = tileBackground('plain');
        expect(coloured).toBeTruthy();
        expect(plain).toBeTruthy();
        expect(coloured).not.toEqual(plain);
    });
});
