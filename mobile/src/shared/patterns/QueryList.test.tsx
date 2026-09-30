/**
 * The list scaffold, rendered for real: each query state shows exactly one
 * thing, search filters and clears, and pull-to-refresh reaches refetch.
 */

import { act, fireEvent, screen } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

import { ApiError, OfflineError } from '@/core/api/client';
import { pullToRefresh, renderWithProviders } from '@/shared/testing/renderWithProviders';

import { QueryList, visibleRows, type ListQuery, type QueryListProps } from './QueryList';

jest.setTimeout(30_000);

interface Row {
    id: string;
    name: string;
    done?: boolean;
}

const ROWS: Row[] = [
    { id: 'a', name: 'Alpha' },
    { id: 'b', name: 'Beta', done: true },
    { id: 'c', name: 'Gamma' },
];

function query(over: Partial<ListQuery<Row>> = {}): ListQuery<Row> {
    return {
        data: ROWS,
        isLoading: false,
        isError: false,
        error: null,
        refetch: jest.fn(),
        ...over,
    };
}

function renderRow({ item }: { item: Row }) {
    return <Text>{item.name}</Text>;
}

async function draw(props: Partial<QueryListProps<Row>> = {}) {
    await renderWithProviders(
        <QueryList<Row>
            query={query()}
            renderItem={renderRow}
            keyExtractor={(row) => row.id}
            empty={{ title: 'No rows yet', message: 'Make one.' }}
            noMatch={{ title: 'Nothing matches', clearLabel: 'Clear search' }}
            {...props}
        />,
    );
}

const byName = (row: Row, needle: string) => row.name.toLowerCase().includes(needle);

describe('QueryList', () => {
    it('shows the skeleton while loading, and nothing else', async () => {
        await draw({ query: query({ isLoading: true, data: undefined }) });
        expect(screen.getByLabelText('Loading')).toBeTruthy();
        expect(screen.queryByText('No rows yet')).toBeNull();
    });

    it('shows the error with a retry that refetches', async () => {
        const refetch = jest.fn();
        await draw({
            query: query({ isError: true, data: undefined, error: new ApiError('boom', { status: 500 }), refetch }),
        });
        expect(screen.getByText('The server had a problem')).toBeTruthy();
        await fireEvent.press(screen.getByText('Try again'));
        expect(refetch).toHaveBeenCalledTimes(1);
    });

    // A background refetch that fails (offline, a 5xx) keeps the rows React
    // Query still holds: the list stays, with a note that it is not fresh.
    it('keeps the loaded rows when a refetch fails, and says so without blocking them', async () => {
        const refetch = jest.fn();
        await draw({ query: query({ isError: true, error: new OfflineError(), refetch }) });
        expect(screen.getByText('Alpha')).toBeTruthy();
        expect(screen.getByText('Gamma')).toBeTruthy();
        expect(screen.getByText('Could not refresh — showing what was loaded before.')).toBeTruthy();
        expect(screen.queryByText('Bee Flow will pick up where you left off once you are back on a network.')).toBeNull();
        await fireEvent.press(screen.getByText('Try again'));
        expect(refetch).toHaveBeenCalledTimes(1);
    });

    it('says nothing about freshness while the rows are current', async () => {
        await draw();
        expect(screen.queryByText('Could not refresh — showing what was loaded before.')).toBeNull();
    });

    it('shows the empty state when the query answered with nothing', async () => {
        const onAction = jest.fn();
        await draw({
            query: query({ data: [] }),
            empty: { title: 'No rows yet', actionLabel: 'Create', onAction },
        });
        expect(screen.getByText('No rows yet')).toBeTruthy();
        await fireEvent.press(screen.getByText('Create'));
        expect(onAction).toHaveBeenCalled();
    });

    it('renders every row', async () => {
        await draw();
        expect(screen.getByText('Alpha')).toBeTruthy();
        expect(screen.getByText('Gamma')).toBeTruthy();
    });

    it('filters locally and offers to clear a search that matches nothing', async () => {
        await draw({ search: { placeholder: 'Search rows', match: byName } });
        await fireEvent.changeText(screen.getByPlaceholderText('Search rows'), 'alp');
        expect(screen.getByText('Alpha')).toBeTruthy();
        expect(screen.queryByText('Beta')).toBeNull();

        await fireEvent.changeText(screen.getByPlaceholderText('Search rows'), 'zzz');
        expect(screen.getByText('Nothing matches')).toBeTruthy();
        await fireEvent.press(screen.getByText('Clear search'));
        expect(screen.getByText('Beta')).toBeTruthy();
    });

    it('reads a server-side miss as "nothing matches", not "none yet"', async () => {
        const onChange = jest.fn();
        await draw({
            query: query({ data: [] }),
            search: { placeholder: 'Search rows', value: 'zzz', onChange },
        });
        expect(screen.getByText('Nothing matches')).toBeTruthy();
        await fireEvent.press(screen.getByText('Clear search'));
        expect(onChange).toHaveBeenCalledWith('');
    });

    it('applies a screen filter before the search', async () => {
        await draw({ filter: (row) => !row.done });
        expect(screen.queryByText('Beta')).toBeNull();
        expect(screen.getByText('Alpha')).toBeTruthy();
    });

    it('pulls to refresh through refetch', async () => {
        const refetch = jest.fn();
        await draw({ query: query({ refetch }), listProps: { testID: 'rows' } });
        await act(async () => pullToRefresh(screen.getByTestId('rows')));
        expect(refetch).toHaveBeenCalledTimes(1);
    });

    it('spins only for the pull, until its refetch settles', async () => {
        let finish: () => void = () => undefined;
        const refetch = jest.fn(() => new Promise<void>((resolve) => (finish = resolve)));
        await draw({ query: query({ refetch }), listProps: { testID: 'rows' } });
        const spinning = () =>
            (screen.getByTestId('rows').props.refreshControl as { props: { refreshing: boolean } }).props.refreshing;
        // A background refetch (a poll, a focus) is not the person's pull.
        expect(spinning()).toBe(false);
        await act(async () => pullToRefresh(screen.getByTestId('rows')));
        expect(spinning()).toBe(true);
        await act(async () => finish());
        expect(spinning()).toBe(false);
    });
});

describe('visibleRows', () => {
    it('keeps everything with no needle, filter or matcher', () => {
        expect(visibleRows(ROWS, '')).toBe(ROWS);
        expect(visibleRows(ROWS, 'alp')).toBe(ROWS);
    });

    it('filters, then matches', () => {
        expect(visibleRows(ROWS, 'a', (row) => !row.done, byName).map((r) => r.id)).toEqual(['a', 'c']);
    });
});
