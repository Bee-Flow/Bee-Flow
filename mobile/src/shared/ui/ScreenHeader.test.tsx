/**
 * The header renders the global accessories the root supplies, and nothing it
 * was not given. This is the seam that keeps shared/ui free of API calls: the
 * bell lives in features/notifications and arrives through context.
 */

import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { HeaderAccessoryProvider } from './headerAccessories';
import { HeaderMenuProvider } from './headerMenu';
import { ScreenHeader } from './ScreenHeader';

jest.setTimeout(30_000);

function FakeBell() {
    return <Text testID="fake-bell">bell</Text>;
}
function FakeSearch() {
    return <Text testID="fake-search">search</Text>;
}
const ACCESSORIES = [FakeSearch, FakeBell];

describe('ScreenHeader accessories', () => {
    it('renders the supplied accessories after the title, in order', async () => {
        await renderWithProviders(
            <HeaderAccessoryProvider accessories={ACCESSORIES}>
                <ScreenHeader title="Projects" />
            </HeaderAccessoryProvider>,
        );
        expect(screen.getByText('Projects')).toBeTruthy();
        const rendered = screen.getAllByText(/^(search|bell)$/).map((node) => node.props.children);
        expect(rendered).toEqual(['search', 'bell']);
    });

    it('leaves them out on a screen that is one of them', async () => {
        await renderWithProviders(
            <HeaderAccessoryProvider accessories={ACCESSORIES}>
                <ScreenHeader title="Notifications" global={false} />
            </HeaderAccessoryProvider>,
        );
        expect(screen.queryByTestId('fake-bell')).toBeNull();
        expect(screen.queryByTestId('fake-search')).toBeNull();
    });

    it('renders none without a provider, so a lone header needs no API', async () => {
        await renderWithProviders(<ScreenHeader title="Alone" />);
        expect(screen.getByText('Alone')).toBeTruthy();
        expect(screen.queryByTestId('fake-bell')).toBeNull();
    });

    it('keeps the back button on a pushed header and drops it on a tab root', async () => {
        await renderWithProviders(<ScreenHeader title="Pushed" />);
        expect(screen.getByLabelText('Back')).toBeTruthy();
        await renderWithProviders(<ScreenHeader title="Root" size="large" />);
        expect(screen.queryByLabelText('Back')).toBeNull();
    });
});

describe('ScreenHeader inside the navigation drawer', () => {
    it('shows the drawer toggle where Back would be, and opens the drawer', async () => {
        const open = jest.fn();
        await renderWithProviders(
            <HeaderMenuProvider menu={{ open }}>
                <ScreenHeader title="Cowork" size="large" />
            </HeaderMenuProvider>,
        );
        expect(screen.queryByLabelText('Back')).toBeNull();
        await fireEvent.press(screen.getByLabelText('Open navigation'));
        expect(open).toHaveBeenCalledTimes(1);
    });

    it('gives a default-size screen in the drawer the toggle too, not Back', async () => {
        await renderWithProviders(
            <HeaderMenuProvider menu={{ open: jest.fn() }}>
                <ScreenHeader title="Apps" />
            </HeaderMenuProvider>,
        );
        expect(screen.getByLabelText('Open navigation')).toBeTruthy();
        expect(screen.queryByLabelText('Back')).toBeNull();
    });

    it('keeps Back where a screen asks for it', async () => {
        await renderWithProviders(
            <HeaderMenuProvider menu={{ open: jest.fn() }}>
                <ScreenHeader title="Library" size="large" showBack />
            </HeaderMenuProvider>,
        );
        expect(screen.getByLabelText('Back')).toBeTruthy();
        expect(screen.queryByLabelText('Open navigation')).toBeNull();
    });

    it('has no toggle outside the drawer', async () => {
        await renderWithProviders(<ScreenHeader title="Root" size="large" />);
        expect(screen.queryByLabelText('Open navigation')).toBeNull();
    });
});
