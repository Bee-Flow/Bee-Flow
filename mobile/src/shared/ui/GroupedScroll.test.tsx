/**
 * The grouped-screen body and the badge row it is usually filled with: the
 * body scrolls its children and wires pull-to-refresh only when asked; the
 * row shows its label and whatever mark it was given.
 */

import { screen } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

import { pullToRefresh, renderWithProviders } from '@/shared/testing/renderWithProviders';

import { BadgeRow } from './BadgeRow';
import { GroupedScroll } from './GroupedScroll';

jest.setTimeout(30_000);

describe('GroupedScroll', () => {
    it('renders its groups and refreshes on a pull', async () => {
        const onRefresh = jest.fn();
        await renderWithProviders(
            <GroupedScroll testID="body" refresh={{ refreshing: false, onRefresh }}>
                <Text>First group</Text>
            </GroupedScroll>,
        );
        expect(screen.getByText('First group')).toBeTruthy();
        pullToRefresh(screen.getByTestId('body'));
        expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it('has no refresh control when nothing is refetchable', async () => {
        await renderWithProviders(
            <GroupedScroll testID="body">
                <Text>Static</Text>
            </GroupedScroll>,
        );
        const scroll = screen.getByTestId('body');
        expect(scroll.props.refreshControl).toBeUndefined();
    });
});

describe('BadgeRow', () => {
    it('shows the label and the mark', async () => {
        await renderWithProviders(
            <BadgeRow label="Status">
                <Text>On</Text>
            </BadgeRow>,
        );
        expect(screen.getByText('Status')).toBeTruthy();
        expect(screen.getByText('On')).toBeTruthy();
    });
});
