/**
 * The detail scaffold: the header survives every state, the body only renders
 * with data, and refresh reaches the right refetch.
 */

import { act, fireEvent, screen } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

import { OfflineError } from '@/core/api/client';
import { pullToRefresh, renderWithProviders } from '@/shared/testing/renderWithProviders';

import { QueryScreen, type DetailQuery } from './QueryScreen';

jest.setTimeout(30_000);

interface Item {
    name: string;
}

function query(over: Partial<DetailQuery<Item>> = {}): DetailQuery<Item> {
    return {
        data: { name: 'Weekly sync' },
        isLoading: false,
        isError: false,
        error: null,
        refetch: jest.fn(),
        ...over,
    };
}

async function draw(q: DetailQuery<Item>, refresh?: () => unknown) {
    await renderWithProviders(
        <QueryScreen
            query={q}
            refresh={refresh}
            loadingLabel="Loading the item"
            header={(data) => <Text>{data ? `Header: ${data.name}` : 'Header: pending'}</Text>}
        >
            {(item) => <Text>Body: {item.name}</Text>}
        </QueryScreen>,
    );
}

describe('QueryScreen', () => {
    it('keeps the header while loading and shows the spinner caption', async () => {
        await draw(query({ isLoading: true, data: undefined }));
        expect(screen.getByText('Header: pending')).toBeTruthy();
        expect(screen.getByText('Loading the item')).toBeTruthy();
        expect(screen.queryByText(/^Body/)).toBeNull();
    });

    it('shows an error with retry when the data could not be loaded', async () => {
        const refetch = jest.fn();
        await draw(query({ isError: true, data: undefined, error: new Error('Gone'), refetch }));
        expect(screen.getByText('Gone')).toBeTruthy();
        await fireEvent.press(screen.getByText('Try again'));
        expect(refetch).toHaveBeenCalled();
    });

    // A background refetch that fails (offline, a 5xx) keeps the data React
    // Query still holds: the body stays, with a note that it is not fresh.
    it('keeps the loaded body when a refetch fails, and says so without blocking it', async () => {
        const refetch = jest.fn();
        await draw(query({ isError: true, error: new OfflineError(), refetch }));
        expect(screen.getByText('Header: Weekly sync')).toBeTruthy();
        expect(screen.getByText('Body: Weekly sync')).toBeTruthy();
        expect(screen.getByText('Could not refresh — showing what was loaded before.')).toBeTruthy();
        await fireEvent.press(screen.getByText('Try again'));
        expect(refetch).toHaveBeenCalledTimes(1);
    });

    it('treats a settled query with no data as an error, not a blank screen', async () => {
        await draw(query({ data: undefined }));
        expect(screen.getByText('This could not be loaded.')).toBeTruthy();
    });

    it('renders the body with the data, under the header', async () => {
        await draw(query());
        expect(screen.getByText('Header: Weekly sync')).toBeTruthy();
        expect(screen.getByText('Body: Weekly sync')).toBeTruthy();
    });

    it('lets the first tap through to a button while the keyboard is up, and drops the keyboard on a drag', async () => {
        await draw(query());
        const scroll = screen.getByTestId('query-screen-scroll');
        expect(scroll.props.keyboardShouldPersistTaps).toBe('handled');
        expect(scroll.props.keyboardDismissMode).toBe('on-drag');
    });

    it('refreshes the query, or the screen\'s own refresh when given', async () => {
        const refetch = jest.fn();
        await draw(query({ refetch }));
        await act(async () => pullToRefresh(screen.getByTestId('query-screen-scroll')));
        expect(refetch).toHaveBeenCalledTimes(1);

        const onRefresh = jest.fn();
        await draw(query({ refetch }), onRefresh);
        await act(async () => pullToRefresh(screen.getAllByTestId('query-screen-scroll').at(-1)));
        expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it('spins only for the pull, until its refetch settles', async () => {
        let finish: () => void = () => undefined;
        const refetch = jest.fn(() => new Promise<void>((resolve) => (finish = resolve)));
        await draw(query({ refetch }));
        const spinning = () =>
            (screen.getByTestId('query-screen-scroll').props.refreshControl as { props: { refreshing: boolean } }).props
                .refreshing;
        // A background refetch (a poll, a focus) is not the person's pull.
        expect(spinning()).toBe(false);
        await act(async () => pullToRefresh(screen.getByTestId('query-screen-scroll')));
        expect(spinning()).toBe(true);
        await act(async () => finish());
        expect(spinning()).toBe(false);
    });
});
