/**
 * The keyboard's own keys on a meeting's details: Next on the title moves on
 * to who is in the meeting and keeps the keyboard up; that field, the last
 * one before the language chips, offers Done rather than a Next with nowhere
 * to go.
 */

import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';
import { TextInput } from 'react-native';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { CaptureSettingsForm } from './CaptureSettingsForm';
import type { CaptureSettings } from '../model/types';

/** The mocked TextInput shares one `focus` across instances; `this` says which field. */
const focus = (TextInput as unknown as { prototype: { focus: jest.Mock } }).prototype.focus;
const focusedFields = () => focus.mock.contexts.map((field) => (field as { props: { accessibilityLabel?: string } }).props.accessibilityLabel);

const VALUE: CaptureSettings = { title: '', attendees: '', language: 'nl', numSpeakers: '', contextTerms: '' };

describe('CaptureSettingsForm', () => {
    it('moves from the title to the attendees on Next, and ends there with Done', async () => {
        focus.mockClear();
        await renderWithProviders(<CaptureSettingsForm value={VALUE} onChange={jest.fn()} />);
        const title = screen.getByLabelText('Title');
        expect(title.props.submitBehavior).toBe('submit');
        await fireEvent(title, 'submitEditing');
        expect(focusedFields()).toEqual(['Who is in the meeting?']);
        expect(screen.getByLabelText('Who is in the meeting?').props.returnKeyType).toBe('done');
    });
});
