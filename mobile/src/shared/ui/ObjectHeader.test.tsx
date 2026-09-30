import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { Badge } from './Badge';
import { Button } from './Button';
import { ObjectHeader } from './ObjectHeader';

jest.setTimeout(30_000);

const mockBack = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ back: mockBack }) }));

describe('ObjectHeader', () => {
    beforeEach(() => mockBack.mockClear());

    it('names the object as a heading, with its status chip and one primary action', async () => {
        const onPublish = jest.fn();
        await renderWithProviders(
            <ObjectHeader
                kind="kb"
                title="Handbook"
                status="Saved · v3"
                primary={<Button size="sm" label="Publish" onPress={onPublish} />}
            />,
        );
        expect(screen.getByRole('header')).toBeTruthy();
        expect(screen.getByText('Handbook')).toBeTruthy();
        expect(screen.getByText('Saved · v3')).toBeTruthy();
        await fireEvent.press(screen.getByRole('button', { name: 'Publish' }));
        expect(onPublish).toHaveBeenCalled();
    });

    it('says Untitled for an empty name and renders an element status as given', async () => {
        await renderWithProviders(<ObjectHeader kind="app" title="  " status={<Badge label="Live" tone="success" />} />);
        expect(screen.getByText('Untitled')).toBeTruthy();
        expect(screen.getByText('Live')).toBeTruthy();
    });

    it('goes back through the router unless told where back goes', async () => {
        await renderWithProviders(<ObjectHeader kind="form" title="Intake" />);
        await fireEvent.press(screen.getByRole('button', { name: 'Back' }));
        expect(mockBack).toHaveBeenCalledTimes(1);

        const onBack = jest.fn();
        await renderWithProviders(
            <ObjectHeader kind="form" title="Intake" onBack={onBack} backLabel="Back to Forms" />,
        );
        await fireEvent.press(screen.getByRole('button', { name: 'Back to Forms' }));
        expect(onBack).toHaveBeenCalledTimes(1);
    });

    it('adds the section tabs under the row', async () => {
        const onTab = jest.fn();
        await renderWithProviders(
            <ObjectHeader
                kind="datatable"
                title="Leads"
                tabs={[
                    { id: 'rows', label: 'Rows', count: 3 },
                    { id: 'schema', label: 'Schema' },
                ]}
                activeTab="rows"
                onTab={onTab}
            />,
        );
        await fireEvent.press(screen.getByRole('tab', { name: 'Schema' }));
        expect(onTab).toHaveBeenCalledWith('schema');
    });

    it('makes the name a button when it does something', async () => {
        const onTitlePress = jest.fn();
        await renderWithProviders(
            <ObjectHeader kind="agent" title="Helper" onTitlePress={onTitlePress} titleHint="Opens details" />,
        );
        await fireEvent.press(screen.getByRole('button', { name: 'Helper' }));
        expect(onTitlePress).toHaveBeenCalled();
    });
});
