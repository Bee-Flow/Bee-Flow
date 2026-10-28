import { act, screen } from '@testing-library/react-native';
import React from 'react';

import { _reset, setCatalogue } from '@/core/i18n';
import type { Destination } from '@/features/sitemap';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { OrgSearchResults } from './OrgSearchResults';

const KEYED: Destination = {
    id: 'org-test',
    i18nKey: 'settings.memory',
    label: 'Memory',
    hintKey: 'settings.memory_desc',
    hint: 'Persisted facts about you, your projects, and preferences',
    icon: 'Bookmark',
    href: '/org/test',
    group: 'Organisation',
};

const PLAIN: Destination = {
    id: 'org-plain',
    label: 'Roles & permissions',
    hint: 'What each organisation role may do',
    icon: 'BadgeCheck',
    href: '/org/roles',
    group: 'Organisation',
};

afterEach(() => {
    _reset();
});

describe('the organisation search answer', () => {
    it('draws a row’s label and hint in the reader’s language', async () => {
        await act(async () => {
            setCatalogue('nl', {
                'settings.memory': 'Geheugen',
                'settings.memory_desc': 'Opgeslagen feiten over jou en je projecten',
            });
        });
        await renderWithProviders(<OrgSearchResults places={[KEYED]} />);
        expect(screen.getByText('Geheugen')).toBeTruthy();
        expect(screen.getByText('Opgeslagen feiten over jou en je projecten')).toBeTruthy();
        expect(screen.queryByText('Memory')).toBeNull();
    });

    it('keeps the English for a destination with no key', async () => {
        await act(async () => {
            setCatalogue('nl', { 'settings.memory': 'Geheugen' });
        });
        await renderWithProviders(<OrgSearchResults places={[PLAIN]} />);
        expect(screen.getByText('Roles & permissions')).toBeTruthy();
        expect(screen.getByText('What each organisation role may do')).toBeTruthy();
    });

    it('falls back to the English of a keyed row the catalogue lacks', async () => {
        await renderWithProviders(<OrgSearchResults places={[KEYED]} />);
        expect(screen.getByText('Memory')).toBeTruthy();
        expect(screen.getByText('Persisted facts about you, your projects, and preferences')).toBeTruthy();
    });
});
