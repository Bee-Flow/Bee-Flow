import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { TranslateFn } from '@/hooks/useTranslation';
import AppExemptionsCard from './AppExemptionsCard';

/**
 * "Exceptions per app", under the kinds-of-data table: per tool column, an
 * app may receive some of the kinds that column holds back. Only held-back
 * kinds are offered, never a secret or an identity-document number.
 */

const t: TranslateFn = (key: string, fallbackOrParams, paramsArg) => {
    const hasStringFallback = typeof fallbackOrParams === 'string';
    const params = hasStringFallback ? paramsArg : fallbackOrParams;
    let out = hasStringFallback ? fallbackOrParams : key;
    for (const [k, v] of Object.entries(params && typeof params === 'object' ? params : {})) out = out.split(`{${k}}`).join(String(v));
    return out;
};

const CATEGORIES = [
    { id: 'Person', group: 'Personal', label: 'Person names' },
    { id: 'Email', group: 'Contact', label: 'Email addresses' },
    { id: 'ApiKeyOrSecret', group: 'Digital', label: 'API keys' },
];
const APPS = [
    { id: 'outlook', label: 'Outlook', classes: ['external' as const] },
    { id: 'nextcloud-mail', label: 'Nextcloud Mail', classes: ['internal' as const] },
];

type Props = React.ComponentProps<typeof AppExemptionsCard>;

function setup(over: Partial<Props> = {}) {
    const props: Props = {
        toolPolicy: {
            external: { blockCategories: ['Person', 'Email', 'ApiKeyOrSecret'], appExemptions: {} },
            internal: { blockCategories: [], appExemptions: {} },
        },
        categories: CATEGORIES,
        apps: APPS,
        appsFailed: false,
        canBlockExternal: true,
        readOnly: false,
        onSet: vi.fn(),
        t,
        ...over,
    };
    render(<AppExemptionsCard {...props} />);
    return props;
}

const externalSection = () => screen.getByRole('group', { name: 'Outside tools' });

describe('AppExemptionsCard', () => {
    it('says in one sentence what an exception does', () => {
        setup();
        expect(screen.getByRole('heading', { name: 'Exceptions per app' })).toBeInTheDocument();
        expect(screen.getByText(/lets one app receive kinds of data this column holds back/)).toBeInTheDocument();
    });

    it('offers only the apps of that column, and adding one starts an empty exception', async () => {
        const props = setup();
        const pick = within(externalSection()).getByRole('combobox', { name: 'Choose an app' });
        expect(within(pick).queryByRole('option', { name: 'Nextcloud Mail' })).toBeNull();
        await userEvent.selectOptions(pick, 'outlook');
        expect(props.onSet).toHaveBeenCalledWith('external', 'outlook', []);
    });

    it('lists the held-back kinds for an app, never a secret, and ticks one in', async () => {
        const props = setup({ toolPolicy: {
            external: { blockCategories: ['Person', 'Email', 'ApiKeyOrSecret'], appExemptions: { outlook: ['Person'] } },
            internal: { blockCategories: [], appExemptions: {} },
        } });
        const section = externalSection();
        expect(within(section).getByRole('checkbox', { name: 'Person names for Outlook' })).toBeChecked();
        expect(within(section).queryByRole('checkbox', { name: /API keys/ })).toBeNull();
        expect(screen.getByText(/API keys and secrets, passport numbers and driving licence numbers/)).toBeInTheDocument();
        await userEvent.click(within(section).getByRole('checkbox', { name: 'Email addresses for Outlook' }));
        expect(props.onSet).toHaveBeenCalledWith('external', 'outlook', ['Person', 'Email']);
        await userEvent.click(within(section).getByRole('button', { name: 'Remove the exception for Outlook' }));
        expect(props.onSet).toHaveBeenCalledWith('external', 'outlook', null);
    });

    it('a column that holds nothing back has nothing to except', () => {
        setup();
        expect(within(screen.getByRole('group', { name: 'Own server' })).getByText(/nothing to make an exception for/)).toBeInTheDocument();
    });

    it('without the outside-tools licence that column is left out, and read-only disables everything', () => {
        setup({ canBlockExternal: false, readOnly: true, toolPolicy: {
            external: { blockCategories: [], appExemptions: {} },
            internal: { blockCategories: ['Email'], appExemptions: { 'nextcloud-mail': ['Email'] } },
        } });
        expect(screen.queryByRole('group', { name: 'Outside tools' })).toBeNull();
        expect(screen.getByRole('checkbox', { name: 'Email addresses for Nextcloud Mail' })).toBeDisabled();
        expect(screen.getByRole('combobox', { name: 'Choose an app' })).toBeDisabled();
    });

    it('says so when the apps could not be loaded', () => {
        setup({ apps: null, appsFailed: true });
        expect(screen.getAllByText(/could not be loaded/).length).toBeGreaterThan(0);
    });
});
