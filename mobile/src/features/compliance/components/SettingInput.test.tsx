/**
 * A list of e-mail addresses is typed on the e-mail keyboard; any other list
 * of words on the ordinary one.
 */

import { screen } from '@testing-library/react-native';
import React from 'react';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { SettingInput } from './SettingInput';
import { SETTING_GROUPS, type SettingField } from '../model/settingsFields';

const field = (name: string) => SETTING_GROUPS.flatMap((g) => g.fields).find((f) => f.name === name) as SettingField;

async function draw(name: string) {
    await renderWithProviders(
        <SettingInput field={field(name)} value={[]} onChange={jest.fn()} users={[]} relevance={null} onRelevance={jest.fn()} contacts={0} />,
    );
    return screen.getByTestId(`setting-${name}`);
}

describe('SettingInput', () => {
    it('types e-mail recipients on the e-mail keyboard', async () => {
        expect(field('breach_recipients').kind).toBe('emails');
        expect((await draw('breach_recipients')).props.keyboardType).toBe('email-address');
    });

    it('types other lists on the ordinary keyboard', async () => {
        expect(field('machinery_manual_subjects').kind).toBe('strings');
        expect((await draw('machinery_manual_subjects')).props.keyboardType).toBeUndefined();
    });
});
