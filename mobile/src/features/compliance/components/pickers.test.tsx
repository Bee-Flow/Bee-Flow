/**
 * The pickers built without a picker dependency: a day (presets, clear,
 * typed), a moment that cannot lie in the future, and the member sheet
 * (search, 'Nobody selected', e-mail only where two names collide, a
 * departed member as '—', several at once).
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { DayField } from './DayField';
import { FieldInput } from './FieldInput';
import { MemberPickerSheet } from './MemberPickerSheet';
import { MomentField } from './MomentField';

jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

const get = api.get as jest.Mock;
const NOW = new Date(2026, 9, 5, 14, 3).getTime();

beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    get.mockReset();
});
afterEach(() => {
    jest.useRealTimers();
});

describe('DayField', () => {
    it('fills a preset, steps a day and clears an optional day', async () => {
        const onChange = jest.fn();
        await renderWithProviders(<DayField label="Due" value="2026-10-05" onChange={onChange} />);
        await fireEvent.press(screen.getByTestId('day-field-preset-today'));
        expect(onChange).toHaveBeenLastCalledWith('2026-10-05');
        await fireEvent.press(screen.getByTestId('day-field-preset-week'));
        expect(onChange).toHaveBeenLastCalledWith('2026-10-12');
        await fireEvent.press(screen.getByTestId('day-field-preset-month'));
        expect(onChange).toHaveBeenLastCalledWith('2026-11-05');
        await fireEvent.press(screen.getByTestId('day-field-preset-year'));
        expect(onChange).toHaveBeenLastCalledWith('2027-10-05');
        await fireEvent.press(screen.getByTestId('day-field-next'));
        expect(onChange).toHaveBeenLastCalledWith('2026-10-06');
        await fireEvent.press(screen.getByTestId('day-field-clear'));
        expect(onChange).toHaveBeenLastCalledWith('');
    });

    it('offers no clear for a required day, and takes a typed day', async () => {
        const onChange = jest.fn();
        await renderWithProviders(<DayField label="Due" value="2026-10-05" required onChange={onChange} />);
        expect(screen.queryByTestId('day-field-clear')).toBeNull();
        await fireEvent.changeText(screen.getByTestId('day-field-input'), '2026-12-24');
        expect(onChange).toHaveBeenLastCalledWith('2026-12-24');
        expect(screen.getByText('5 Oct')).toBeTruthy();
    });
});

describe('MomentField', () => {
    it('picks presets and shows the moment with its time', async () => {
        const onChange = jest.fn();
        await renderWithProviders(<MomentField label="Became aware at" value={new Date(NOW).toISOString()} onChange={onChange} />);
        expect(screen.getByTestId('moment-field-value')).toHaveTextContent('5 Oct 14:03');
        await fireEvent.press(screen.getByTestId('moment-field-preset-yesterday'));
        expect(onChange).toHaveBeenLastCalledWith(new Date(2026, 9, 4, 9, 0).toISOString());
        await fireEvent.press(screen.getByTestId('moment-field-preset-hour'));
        expect(onChange).toHaveBeenLastCalledWith(new Date(NOW - 3_600_000).toISOString());
    });

    it('refuses to move into the future', async () => {
        const onChange = jest.fn();
        await renderWithProviders(<MomentField label="Became aware at" value={new Date(NOW - 30 * 60_000).toISOString()} onChange={onChange} />);
        await fireEvent.press(screen.getByTestId('moment-field-hour-up'));
        expect(onChange).toHaveBeenLastCalledWith(new Date(NOW).toISOString());
        await fireEvent.press(screen.getByTestId('moment-field-minute-down'));
        expect(onChange).toHaveBeenLastCalledWith(new Date(NOW - 35 * 60_000).toISOString());
    });
});

const MEMBERS = [
    { id: 'u1', displayName: 'Jan de Vries', email: 'jan@a.nl' },
    { id: 'u2', displayName: 'Jan de Vries', email: 'jan@b.nl' },
    { id: 'u3', displayName: 'Ann Smit', email: 'ann@a.nl' },
];

describe('MemberPickerSheet', () => {
    beforeEach(() => get.mockResolvedValue(MEMBERS));

    it('searches, tells two of the same name apart and keeps a departed member', async () => {
        const onChange = jest.fn();
        await renderWithProviders(<MemberPickerSheet title="Owner" value="gone" onChange={onChange} onClose={jest.fn()} />);
        expect(await screen.findByText('Jan de Vries (jan@a.nl)')).toBeTruthy();
        expect(screen.getByText('Ann Smit')).toBeTruthy();
        expect(screen.queryByText('ann@a.nl')).toBeNull();
        expect(screen.getByText('—')).toBeTruthy();
        await fireEvent.changeText(screen.getByPlaceholderText('Search'), 'ann');
        expect(screen.queryByText('Jan de Vries (jan@a.nl)')).toBeNull();
        await fireEvent.press(screen.getByText('Ann Smit'));
        expect(onChange).toHaveBeenCalledWith('u3');
    });

    it("offers 'Nobody selected' only when the field is optional", async () => {
        const onChange = jest.fn();
        const onClose = jest.fn();
        await renderWithProviders(<MemberPickerSheet title="Owner" value="u3" onChange={onChange} onClose={onClose} />);
        await fireEvent.press(await screen.findByText('Nobody selected'));
        expect(onChange).toHaveBeenCalledWith('');
        expect(onClose).toHaveBeenCalled();
    });

    it("offers no 'Nobody selected' for a required field", async () => {
        await renderWithProviders(<MemberPickerSheet title="Owner" value="u3" required onChange={jest.fn()} onClose={jest.fn()} />);
        await screen.findByText('Ann Smit');
        expect(screen.queryByText('Nobody selected')).toBeNull();
    });

    it('selects several in multi mode', async () => {
        const onChange = jest.fn();
        await renderWithProviders(<MemberPickerSheet title="Recipients" value={['u1']} multi onChange={onChange} onClose={jest.fn()} />);
        await fireEvent.press(await screen.findByText('Ann Smit'));
        expect(onChange).toHaveBeenLastCalledWith(['u1', 'u3']);
        await fireEvent.press(screen.getByText('Jan de Vries (jan@a.nl)'));
        expect(onChange).toHaveBeenLastCalledWith([]);
    });
});

describe('FieldInput', () => {
    it('shows a member field by name, an unknown one as —, and options per record', async () => {
        get.mockResolvedValue(MEMBERS);
        await renderWithProviders(
            <>
                <FieldInput spec={{ key: 'owner', label: { i18nKey: 'x.a', en: 'Owner' }, kind: 'user' }} value="u3" onChange={jest.fn()} />
                <FieldInput spec={{ key: 'old', label: { i18nKey: 'x.b', en: 'Old owner' }, kind: 'user' }} value="gone" onChange={jest.fn()} />
                <FieldInput
                    spec={{
                        key: 'stage',
                        label: { i18nKey: 'x.c', en: 'Stage' },
                        kind: 'choice',
                        optionsFor: (rec) => [{ value: String(rec?.next), label: 'Next', hint: { i18nKey: 'x.h', en: 'Starts the clock' } }],
                    }}
                    value="b"
                    rec={{ next: 'b' }}
                    onChange={jest.fn()}
                />
            </>,
        );
        await waitFor(() => expect(screen.getByText('Ann Smit')).toBeTruthy());
        expect(screen.getByText('—')).toBeTruthy();
        expect(screen.getByTestId('field-stage-b')).toBeTruthy();
        expect(screen.getByTestId('field-stage-hint')).toHaveTextContent('Starts the clock');
    });

    it('draws a preview line and a JSON field', async () => {
        await renderWithProviders(
            <>
                <FieldInput spec={{ key: 'cfg', label: { i18nKey: 'x.d', en: 'Config' }, kind: 'json', preview: (v) => `len ${String(v).length}` }} value="{}" onChange={jest.fn()} />
            </>,
        );
        expect(screen.getByTestId('field-cfg-preview')).toHaveTextContent('len 2');
        expect(screen.getByTestId('field-cfg').props.multiline).toBe(true);
    });
});
