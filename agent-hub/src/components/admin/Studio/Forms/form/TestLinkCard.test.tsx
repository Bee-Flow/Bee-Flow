import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TestLinkCard from './TestLinkCard';
import type { FormDetail } from './useFormDetail';
import type { FormTestLink, FormTestLinkApi } from '@/api/formTestLink';
import { renderWithClient } from '@/test/render';

/**
 * Share → Test link: none yet offers "Make a test link"; a link shows its
 * address, copy and open, its expiry, who may open it (the maker alone by
 * default) and a way to stop it, which asks first. A reader sees no controls.
 * The api is handed in; the org directory answers through a stubbed fetch.
 */

const LINK: FormTestLink = {
    token: 't'.repeat(48), url: `/f/${'t'.repeat(48)}`, createdAt: null,
    expiresAt: '2026-11-17T12:00:00.000Z', issuedByUserId: 'u-me',
    audience: { mode: 'restricted', groups: [], users: ['u-me'] },
};
const FORM = (testLink: FormTestLink | null): FormDetail => ({ automationId: 'au1', mine: true, testLink, audience: { mode: 'org' }, definition: {} });

let api: FormTestLinkApi & { create: ReturnType<typeof vi.fn>; revoke: ReturnType<typeof vi.fn>; setAudience: ReturnType<typeof vi.fn> };

beforeEach(() => {
    cleanup();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => [] })));
    api = {
        create: vi.fn(async () => ({ testLink: LINK })),
        revoke: vi.fn(async () => ({ revoked: true })),
        setAudience: vi.fn(async (_id: string, body: { audience: string; sharedGroups: string[]; sharedUserIds: string[] }) => ({ testLink: { ...LINK, audience: { mode: body.audience, groups: body.sharedGroups, users: body.sharedUserIds } } })),
    };
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('<TestLinkCard>', () => {
    it('without a link: one button makes it, then the host reloads', async () => {
        const user = userEvent.setup();
        const onChanged = vi.fn();
        renderWithClient(<TestLinkCard form={FORM(null)} canEdit onChanged={onChanged} api={api} />);
        expect(screen.queryByTestId('form-test-link-url')).toBeNull();
        await user.click(screen.getByTestId('form-test-link-create'));
        await waitFor(() => expect(api.create).toHaveBeenCalledWith('au1'));
        expect(onChanged).toHaveBeenCalled();
    });

    it('with a link: the address, copy and open, the expiry and who may open it (the maker alone)', () => {
        renderWithClient(<TestLinkCard form={FORM(LINK)} canEdit api={api} />);
        expect(screen.getByTestId('form-test-link-url').textContent).toContain(LINK.url);
        expect(screen.getByTestId('form-test-link-copy').textContent).toBe('Copy the link');
        expect(screen.getByTestId('form-test-link-open').getAttribute('href')).toContain(LINK.url);
        expect(screen.getByTestId('form-test-link-expiry').textContent).toMatch(/^Works until /);
        expect(screen.getAllByText('Who can open the test link').length).toBeGreaterThan(0);
        expect((screen.getByTestId('form-test-link-audience-restricted').querySelector('input') as HTMLInputElement).checked).toBe(true);
    });

    it('widening who may open it writes the TEST link\'s audience, not the form\'s', async () => {
        const user = userEvent.setup();
        renderWithClient(<TestLinkCard form={FORM(LINK)} canEdit api={api} />);
        await user.click(screen.getByTestId('form-test-link-audience-org'));
        await user.click(await screen.findByRole('button', { name: 'Open to everyone' }));
        await waitFor(() => expect(api.setAudience).toHaveBeenCalledWith('au1', { audience: 'org', sharedGroups: [], sharedUserIds: ['u-me'] }));
    });

    it('stopping the link asks first', async () => {
        const user = userEvent.setup();
        renderWithClient(<TestLinkCard form={FORM(LINK)} canEdit api={api} />);
        await user.click(screen.getByTestId('form-test-link-revoke'));
        expect(api.revoke).not.toHaveBeenCalled();
        await user.click(await screen.findByRole('button', { name: 'Stop it' }));
        await waitFor(() => expect(api.revoke).toHaveBeenCalledWith('au1'));
    });

    it('a link that does not expire says so; a reader gets no controls', () => {
        renderWithClient(<TestLinkCard form={FORM({ ...LINK, expiresAt: null })} canEdit={false} api={api} />);
        expect(screen.getByTestId('form-test-link-expiry').textContent).toBe('Does not expire.');
        expect(screen.queryByTestId('form-test-link-revoke')).toBeNull();
        expect(screen.queryByTestId('form-test-link-renew')).toBeNull();
    });
});
