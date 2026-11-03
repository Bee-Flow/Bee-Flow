import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The hosted form page opened through a TEST LINK says so (a Test banner),
 * and a form that is not live yet tells the one person who may edit it why
 * it does not open (409 form_not_live) instead of "not available". Everybody
 * else still gets the one indistinguishable "not available".
 */

const { default: PublicFormPage } = await import('./PublicFormPage');

const TOKEN = 'd'.repeat(48);
const FORM = {
    title: 'Contact us',
    description: '',
    submitLabel: 'Send it',
    successMessage: 'Thanks',
    theme: { primary: '#0F766E', radius: 'md', density: 'comfortable', fontScale: 'md', appearance: 'light' },
    fields: [{ name: 'email', type: 'email', label: 'Your email', required: true }],
};

function answer(status: number, body: unknown) {
    return vi.fn(async () => ({ ok: status < 400, status, json: async () => body }));
}

describe('PublicFormPage — test link and not live yet', () => {
    beforeEach(() => {
        cleanup();
        window.history.replaceState(null, '', `/f/${TOKEN}`);
    });
    afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

    it('a test link shows the Test banner above the form', async () => {
        vi.stubGlobal('fetch', answer(200, { form: FORM, csrf: 'c1', issuedAt: Date.now(), test: true }));
        render(<PublicFormPage token={TOKEN} />);
        await screen.findByText('Contact us');
        const banner = screen.getByTestId('form-test-banner');
        expect(banner.getAttribute('role')).toBe('note');
        expect(banner.textContent).toContain('You opened a test link');
    });

    it('the production link shows no banner', async () => {
        vi.stubGlobal('fetch', answer(200, { form: FORM, csrf: 'c1', issuedAt: Date.now() }));
        render(<PublicFormPage token={TOKEN} />);
        await screen.findByText('Contact us');
        expect(screen.queryByTestId('form-test-banner')).toBeNull();
    });

    it('an editor of a form that is not live is told so, with the way to the automation', async () => {
        vi.stubGlobal('fetch', answer(409, { error: 'not live', code: 'form_not_live', isActive: false, isDraft: true, automationId: 'au1' }));
        render(<PublicFormPage token={TOKEN} />);
        expect(await screen.findByText('This form is not live yet')).toBeTruthy();
        const link = screen.getByRole('link', { name: 'Open the automation' });
        expect(link.getAttribute('href')).toBe('/app/studio/automations/au1');
        expect(screen.queryByText('This form is not available')).toBeNull();
    });

    it('anyone else still gets the one "not available"', async () => {
        vi.stubGlobal('fetch', answer(404, { error: 'Not found' }));
        render(<PublicFormPage token={TOKEN} />);
        expect(await screen.findByText('This form is not available')).toBeTruthy();
        expect(screen.queryByTestId('form-not-live')).toBeNull();
    });
});
