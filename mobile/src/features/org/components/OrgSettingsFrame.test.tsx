/**
 * The org-settings frame's query states: a first load that fails is the full
 * error, but a refetch that fails over loaded data keeps the section on
 * screen with a note that it is not fresh.
 */

import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

import { OfflineError } from '@/core/api/client';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { OrgSettingsFrame, type FrameQuery } from './OrgSettingsFrame';

jest.setTimeout(30_000);

const STALE = 'Could not refresh — showing what was loaded before.';

function query(over: Partial<FrameQuery<{ name: string }>> = {}): FrameQuery<{ name: string }> {
    return { data: { name: 'Acme' }, isLoading: false, isError: false, error: null, refetch: jest.fn(), ...over };
}

async function draw(q: FrameQuery<{ name: string }>, list = false) {
    await renderWithProviders(
        <OrgSettingsFrame title="Organisation" allowed list={list} query={q}>
            {(data) => <Text>Name: {data.name}</Text>}
        </OrgSettingsFrame>,
    );
}

describe('OrgSettingsFrame', () => {
    it('shows the full error when nothing was loaded', async () => {
        await draw(query({ isError: true, data: undefined, error: new OfflineError() }));
        expect(screen.getByText('You are offline')).toBeTruthy();
        expect(screen.queryByText(/^Name:/)).toBeNull();
    });

    it('keeps the loaded section when a refetch fails, with a note and a retry', async () => {
        const refetch = jest.fn();
        await draw(query({ isError: true, error: new OfflineError(), refetch }));
        expect(screen.getByText('Name: Acme')).toBeTruthy();
        expect(screen.getByText(STALE)).toBeTruthy();
        await fireEvent.press(screen.getByText('Try again'));
        expect(refetch).toHaveBeenCalledTimes(1);
    });

    it('keeps a list body too', async () => {
        await draw(query({ isError: true, error: new OfflineError() }), true);
        expect(screen.getByText('Name: Acme')).toBeTruthy();
        expect(screen.getByText(STALE)).toBeTruthy();
    });

    it('says nothing about freshness while the data is current', async () => {
        await draw(query());
        expect(screen.getByText('Name: Acme')).toBeTruthy();
        expect(screen.queryByText(STALE)).toBeNull();
    });
});
