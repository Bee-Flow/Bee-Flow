import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { DataList, type DataColumn } from './DataList';
import { columnStyle } from './DataListRow';

jest.setTimeout(30_000);

interface Lead {
    id: string;
    name: string;
    score: number;
}

const COLUMNS: DataColumn<Lead>[] = [
    { id: 'name', label: 'Name', render: (row) => row.name },
    { id: 'score', label: 'Score', width: 64, align: 'right', render: (row) => row.score },
];
const ROWS: Lead[] = [
    { id: 'a', name: 'Acme', score: 91 },
    { id: 'b', name: 'Bolt', score: 40 },
];

describe('columnStyle', () => {
    it('gives a fixed column its width and a flexible one its share', () => {
        expect(columnStyle({ width: 64, align: 'right' })).toEqual({ width: 64, alignItems: 'flex-end' });
        expect(columnStyle({ flex: 2 })).toEqual({ flex: 2, minWidth: 0, alignItems: 'flex-start' });
        expect(columnStyle({})).toMatchObject({ flex: 1 });
    });
});

describe.each([true, false])('DataList (virtualized: %s)', (virtualized) => {
    it('draws the header from the same columns as the rows', async () => {
        await renderWithProviders(<DataList columns={COLUMNS} rows={ROWS} virtualized={virtualized} />);
        expect(screen.getByText('Name')).toBeTruthy();
        expect(screen.getByText('Score')).toBeTruthy();
        expect(screen.getByText('Acme')).toBeTruthy();
        expect(screen.getByText('91')).toBeTruthy();
    });

    it('opens a row with its own data', async () => {
        const onRowPress = jest.fn();
        await renderWithProviders(
            <DataList
                columns={COLUMNS}
                rows={ROWS}
                virtualized={virtualized}
                onRowPress={onRowPress}
                rowLabel={(row) => `Lead ${row.name}`}
                rowAccent={(row) => (row.score < 50 ? 'warning' : null)}
            />,
        );
        await fireEvent.press(screen.getByRole('button', { name: 'Lead Bolt' }));
        expect(onRowPress).toHaveBeenCalledWith(ROWS[1]);
    });

    it('shows the empty state instead of rows when there are none', async () => {
        await renderWithProviders(
            <DataList columns={COLUMNS} rows={[]} virtualized={virtualized} empty={<Text>No leads</Text>} />,
        );
        expect(screen.getByText('No leads')).toBeTruthy();
        expect(screen.getByText('Name')).toBeTruthy();
    });
});
