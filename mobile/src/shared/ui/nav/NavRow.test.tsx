import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { navCount, NavRow, plainCount } from './NavRow';
import { SectionLabel } from './SectionLabel';

jest.setTimeout(30_000);

describe('navCount', () => {
    it('shows a count worth acting on and nothing else, like the web NavCountBadge', () => {
        expect(navCount(3)).toBe('3');
        expect(navCount(0)).toBeNull();
        expect(navCount(0.9)).toBeNull();
        expect(navCount(null)).toBeNull();
        expect(navCount(undefined)).toBeNull();
        expect(navCount(Number.NaN)).toBeNull();
        expect(navCount(250)).toBe('99+');
    });
});

describe('plainCount', () => {
    it('shows any known number, 0 included, like the Studio flyout', () => {
        expect(plainCount(0)).toBe('0');
        expect(plainCount(14)).toBe('14');
        expect(plainCount(250)).toBe('250');
        expect(plainCount(null)).toBeNull();
        expect(plainCount(undefined)).toBeNull();
        expect(plainCount(Number.NaN)).toBeNull();
    });
});

describe('NavRow', () => {
    it('announces the current destination and its count', async () => {
        const onPress = jest.fn();
        await renderWithProviders(<NavRow label="Approvals" icon="ShieldCheck" active count={2} onPress={onPress} />);
        const row = screen.getByRole('link', { name: 'Approvals, 2' });
        expect(row.props.accessibilityState).toMatchObject({ selected: true });
        await fireEvent.press(row);
        expect(onPress).toHaveBeenCalled();
    });

    it('is a button with an expanded state when it heads a group', async () => {
        await renderWithProviders(<NavRow label="Studio" icon="LayoutGrid" expanded={false} onPress={jest.fn()} />);
        expect(screen.getByRole('button', { name: 'Studio' }).props.accessibilityState).toMatchObject({
            expanded: false,
            selected: false,
        });
    });
});

describe('NavRow count styles and lines', () => {
    it('draws a plain count as figures, and a zero one too', async () => {
        await renderWithProviders(<NavRow label="Datatables" icon="Table2" count={0} countStyle="plain" onPress={jest.fn()} />);
        expect(screen.getByRole('link', { name: 'Datatables, 0' })).toBeTruthy();
        expect(screen.getByText('0')).toBeTruthy();
    });

    it('draws the description under the label', async () => {
        await renderWithProviders(
            <NavRow label="Intake" icon="ClipboardList" description="Not live" accessibilityHint="Not live" onPress={jest.fn()} />,
        );
        expect(screen.getByText('Not live')).toBeTruthy();
    });

    it('draws a leading node in place of the icon', async () => {
        const { Text } = jest.requireActual('react-native');
        await renderWithProviders(<NavRow label="Plans" leading={<Text>📁</Text>} onPress={jest.fn()} />);
        expect(screen.getByText('📁')).toBeTruthy();
    });
});

describe('SectionLabel', () => {
    it('is a header when it only labels', async () => {
        await renderWithProviders(<SectionLabel label="My agents" />);
        expect(screen.getByRole('header')).toBeTruthy();
        expect(screen.getByText('My agents')).toBeTruthy();
    });

    it('toggles its group when pressable', async () => {
        const onPress = jest.fn();
        await renderWithProviders(<SectionLabel label="Projects" onPress={onPress} expanded={false} />);
        const toggle = screen.getByRole('button', { name: 'Projects' });
        expect(toggle.props.accessibilityState).toMatchObject({ expanded: false });
        await fireEvent.press(toggle);
        expect(onPress).toHaveBeenCalled();
    });
});
