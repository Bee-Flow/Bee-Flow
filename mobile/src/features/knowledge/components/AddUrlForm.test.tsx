/**
 * The link door: an address without `https://` is sent with it, and one that
 * is not an address at all is caught before the round trip, in words.
 */

import { fireEvent, screen } from '@testing-library/react-native';
import React, { useState } from 'react';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { AddUrlForm, type UrlDraft } from './AddUrlForm';

function Harness({ onUrl }: { onUrl: (url: string) => void }) {
    const [draft, setDraft] = useState<UrlDraft>({ url: '', error: null });
    return <AddUrlForm draft={draft} onChange={setDraft} busy={false} onUrl={onUrl} onBack={jest.fn()} />;
}

describe('AddUrlForm', () => {
    it('sends an address typed without a scheme with https://, and says so under the field', async () => {
        const onUrl = jest.fn();
        await renderWithProviders(<Harness onUrl={onUrl} />);
        expect(screen.getByText(/You can leave out https:\/\/ — it is added for you\./)).toBeTruthy();
        await fireEvent.changeText(screen.getByLabelText('Web address'), 'example.com/report');
        await fireEvent.press(screen.getByText('Add link'));
        expect(onUrl).toHaveBeenCalledWith('https://example.com/report');
        expect(screen.getByLabelText('Web address').props.value).toBe('');
    });

    it('says what is wrong with something that is not an address, and sends nothing', async () => {
        const onUrl = jest.fn();
        await renderWithProviders(<Harness onUrl={onUrl} />);
        await fireEvent.changeText(screen.getByLabelText('Web address'), 'report');
        await fireEvent.press(screen.getByText('Add link'));
        expect(onUrl).not.toHaveBeenCalled();
        expect(screen.getByText('Enter a web address, such as example.com/report.')).toBeTruthy();
    });
});
