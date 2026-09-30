/**
 * Filling a form in over a mocked HTTP client: a one-page form checks its
 * answers, sends them with its CSRF and nonce and thanks the person; the
 * server's per-field refusals land under their questions; a multi-page form
 * follows its session to page two and on to the closing page; a link that
 * leads nowhere says so; Back with an answer typed asks first.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { api, ApiError } from '@/core/api/client';
import { ConfirmProvider } from '@/shared/patterns';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';
import { pressBack, type HeldLeave } from '@/shared/testing/screenMocks';
import { ToastProvider } from '@/shared/ui';

import { FillFormScreen } from './FillFormScreen';

jest.setTimeout(20_000);

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), setParams: jest.fn() };
const mockLeave: HeldLeave = { listener: null, dispatch: jest.fn() };
jest.mock('expo-router', () => ({
    useRouter: () => mockRouter,
    useNavigation: jest.requireActual('@/shared/testing/screenMocks').leaveNavigation(() => mockLeave),
}));
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

const TOKEN = 'a1b2'.repeat(12);
const SID = 'f'.repeat(32);
const BASE = `/api/automation/form/${TOKEN}`;

const page = (title: string, fields: unknown[], extra: Record<string, unknown> = {}) => ({
    title,
    description: '',
    submitLabel: 'Send it',
    successMessage: 'Thanks — all in.',
    theme: { primary: '#1D4ED8', radius: 'lg', density: 'comfortable' },
    fields,
    ...extra,
});

const NAME = { name: 'full_name', type: 'text', label: 'Your name', required: true, placeholder: '', help: '' };
const EMAIL = { name: 'email', type: 'email', label: 'Email', required: false, placeholder: '', help: '' };

async function mount() {
    await renderWithProviders(
        <ToastProvider>
            <ConfirmProvider>
                <FillFormScreen token={TOKEN} />
            </ConfirmProvider>
        </ToastProvider>,
    );
}

/** A text on screen — the header repeats a page's title, so once or twice. */
async function seen(text: string) {
    expect((await screen.findAllByText(text, {}, { timeout: 5000 })).length).toBeGreaterThan(0);
}

/** Past the server's two-second "posted the instant it loaded" check, without waiting for it. */
const realNow = Date.now.bind(Date);
let skipped = 0;
function later() {
    skipped += 60_000;
    jest.spyOn(Date, 'now').mockImplementation(() => realNow() + skipped);
}

beforeEach(() => {
    jest.clearAllMocks();
    mockLeave.listener = null;
});
afterEach(async () => {
    jest.restoreAllMocks();
    await cleanup();
});

it('checks the answers, sends them with the page’s CSRF and a nonce, and thanks the person', async () => {
    (api.get as jest.Mock).mockResolvedValue({ form: page('Intake', [NAME, EMAIL]), csrf: 'csrf1', issuedAt: 100 });
    (api.post as jest.Mock).mockResolvedValue({ accepted: true, sessionId: SID });
    await mount();
    await seen('Intake');

    later();
    await fireEvent.press(screen.getByTestId('fill-submit'));
    expect(await screen.findByText('Your name is required.')).toBeTruthy();
    expect(api.post).not.toHaveBeenCalled();

    await fireEvent.changeText(screen.getByTestId('fill-full_name'), 'Anna');
    await fireEvent.changeText(screen.getByTestId('fill-email'), 'anna@');
    await fireEvent.press(screen.getByTestId('fill-submit'));
    expect(await screen.findByText('That is not an email address.')).toBeTruthy();

    await fireEvent.changeText(screen.getByTestId('fill-email'), 'anna@example.org');
    await fireEvent.press(screen.getByTestId('fill-submit'));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    const [path, body] = (api.post as jest.Mock).mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe(BASE);
    expect(body).toMatchObject({ full_name: 'Anna', email: 'anna@example.org', csrf: 'csrf1', issuedAt: 100 });
    expect(String(body.nonce)).toMatch(/^[A-Za-z0-9_-]{8,80}$/);
    await seen('Thanks — all in.');
});

it('shows the server’s refusal under the question it is about', async () => {
    (api.get as jest.Mock).mockResolvedValue({ form: page('Intake', [NAME]), csrf: 'c', issuedAt: 1 });
    (api.post as jest.Mock).mockRejectedValue(
        new ApiError('Some answers need attention', { status: 400, body: { error: 'Some answers need attention', fields: [{ field: 'full_name', message: 'Your name is taken.' }] } }),
    );
    await mount();
    await seen('Intake');
    later();
    await fireEvent.changeText(screen.getByTestId('fill-full_name'), 'Anna');
    await fireEvent.press(screen.getByTestId('fill-submit'));
    expect(await screen.findByText('Your name is taken.')).toBeTruthy();
});

it('follows a multi-page journey to its second page and its closing page', async () => {
    const two = page('Page two', [{ name: 'why', type: 'textarea', label: 'Why?', required: true, placeholder: '', help: '' }]);
    let polls = 0;
    (api.get as jest.Mock).mockImplementation(async (path: string) => {
        if (path === BASE) return { form: page('Intake', [NAME], { multiPage: true }), csrf: 'c1', issuedAt: 1 };
        if (path === `${BASE}/s/${SID}`) {
            polls += 1;
            if (polls === 1) return { state: 'working', progress: ['Research', 'Search the web'] };
            if (polls === 2) return { state: 'form', stepId: 's2', form: two, csrf: 'c2', issuedAt: 2 };
            return { state: 'done', ending: page('All done', [], { description: '' }) };
        }
        return null;
    });
    (api.post as jest.Mock).mockResolvedValue({ accepted: true, sessionId: SID });
    await mount();
    await seen('Intake');
    later();
    await fireEvent.changeText(screen.getByTestId('fill-full_name'), 'Anna');
    await fireEvent.press(screen.getByTestId('fill-submit'));

    expect(await screen.findByText('Search the web', {}, { timeout: 5000 })).toBeTruthy();
    await seen('Page two');
    expect(mockRouter.setParams).toHaveBeenCalledWith({ s: SID });

    await fireEvent.changeText(screen.getByTestId('fill-why'), 'Because');
    later();
    await fireEvent.press(screen.getByTestId('fill-submit'));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect((api.post as jest.Mock).mock.calls[1]?.[0]).toBe(`${BASE}/s/${SID}`);
    expect((api.post as jest.Mock).mock.calls[1]?.[1]).toMatchObject({ why: 'Because', csrf: 'c2' });
    await seen('All done');
});

it('asks before Back throws typed answers away, and lets an untouched page go', async () => {
    (api.get as jest.Mock).mockResolvedValue({ form: page('Intake', [NAME, EMAIL]), csrf: 'c', issuedAt: 1 });
    await mount();
    await seen('Intake');
    expect(mockLeave.listener).toBeNull();

    await fireEvent.changeText(screen.getByTestId('fill-full_name'), 'Anna');
    const held = await pressBack(mockLeave);
    expect(held.preventDefault).toHaveBeenCalled();
    expect(await screen.findByText('Unsaved changes')).toBeTruthy();
    await fireEvent.press(screen.getByText('Cancel'));
    expect(mockLeave.dispatch).not.toHaveBeenCalled();
    expect(screen.getByTestId('fill-full_name').props.value).toBe('Anna');

    // Spaces are not an answer: clearing the field lets Back through unasked.
    await fireEvent.changeText(screen.getByTestId('fill-full_name'), '  ');
    await waitFor(() => expect(mockLeave.listener).toBeNull());
});

it('says a form is not available when the link leads nowhere', async () => {
    (api.get as jest.Mock).mockRejectedValue(new ApiError('Not found', { status: 404, body: { error: 'Not found' } }));
    await mount();
    expect(await screen.findByText('This form is not available')).toBeTruthy();
});

it('says so when the server cannot be reached', async () => {
    (api.get as jest.Mock).mockRejectedValue(new TypeError('Network request failed'));
    await mount();
    expect(await screen.findByText('Could not reach the server')).toBeTruthy();
});
