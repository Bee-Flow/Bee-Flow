/**
 * "Used by": rows named and linked, and the three answers kept apart —
 * still asking, could not ask, and asked but could not check every kind.
 */

import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { usageHref, usageSubtitle, usageTitle } from './usedBy';
import { UsedByList } from './UsedByList';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
    useRouter: () => ({ push: mockPush, canDismiss: () => false, navigate: jest.fn(), dismissTo: jest.fn() }),
}));

const t = (_k: string, fallback: string, p: Record<string, unknown> = {}) => fallback.replace(/\{(\w+)\}/g, (_, k: string) => String(p[k]));

describe('usedBy words', () => {
    it('names a row, says what it does and where it opens', () => {
        const row = { kind: 'automation', id: 'a 1', title: 'Nightly', role: 'ai_step', siteLabel: 'step 3' };
        expect(usageTitle(t, row)).toBe('Nightly');
        expect(usageSubtitle(t, row)).toBe('routine · AI step · step 3');
        expect(usageHref(row)).toBe('/automations/a%201');
    });

    it('never opens someone else’s row, or a kind without a screen', () => {
        expect(usageTitle(t, { kind: 'agent', id: 'x', foreign: true })).toBe('Someone else’s agent');
        expect(usageHref({ kind: 'agent', id: 'x', foreign: true })).toBeNull();
        expect(usageHref({ kind: 'app', id: 'x' })).toBeNull();
        expect(usageTitle(t, { kind: 'agent', id: 'x', title: ' ' })).toBe('Untitled agent');
    });
});

describe('UsedByList', () => {
    beforeEach(() => mockPush.mockReset());

    it('lists the rows and opens one', async () => {
        await renderWithProviders(
            <UsedByList answer={{ usage: [{ kind: 'agent', id: 'a1', title: 'Sales bot', role: 'chat' }], unchecked: [] }}
                isLoading={false} error={null} onRetry={jest.fn()} emptyText="Nothing" />,
        );
        await fireEvent.press(screen.getByText('Sales bot'));
        expect(mockPush).toHaveBeenCalledWith('/agents/a1');
        expect(screen.queryByText('Nothing')).toBeNull();
    });

    it('says a complete empty answer, and only then', async () => {
        await renderWithProviders(<UsedByList answer={{ usage: [], unchecked: [] }} isLoading={false} error={null} onRetry={jest.fn()} emptyText="Nothing uses it" />);
        expect(screen.getByText('Nothing uses it')).toBeTruthy();
    });

    it('names the kinds nobody could check instead of claiming nothing', async () => {
        await renderWithProviders(<UsedByList answer={{ usage: [], unchecked: ['automation'] }} isLoading={false} error={null} onRetry={jest.fn()} emptyText="Nothing uses it" />);
        expect(screen.getByText('Could not be checked: routines. This list is incomplete.')).toBeTruthy();
        expect(screen.queryByText('Nothing uses it')).toBeNull();
    });

    it('says a failed read failed, with a retry', async () => {
        const retry = jest.fn();
        await renderWithProviders(<UsedByList answer={undefined} isLoading={false} error={new Error('x')} onRetry={retry} emptyText="Nothing" />);
        await fireEvent.press(screen.getByText('Try again'));
        expect(retry).toHaveBeenCalled();
        expect(screen.queryByText('Nothing')).toBeNull();
    });
});
