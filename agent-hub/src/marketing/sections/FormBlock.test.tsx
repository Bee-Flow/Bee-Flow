import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import FormBlock from './FormBlock';
import { BlockIdContext } from '../components/EditableText';

const DATA = {
    enabled: true,
    title: 'Request a demo',
    submitLabel: 'Send',
    successTitle: 'Thank you',
    successBody: 'We will be in touch.',
    errorText: 'Something went wrong.',
    consent: { enabled: true, text: 'I agree to be contacted.' },
    fields: [
        { id: 'name', type: 'text', label: 'Name', required: true },
        { id: 'email', type: 'email', label: 'Email', required: true },
    ],
};

function renderForm(data = DATA) {
    return render(
        <BlockIdContext.Provider value="blk_1">
            <FormBlock data={data} />
        </BlockIdContext.Provider>,
    );
}

async function fillAndSend(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText(/^Name/), 'Ada');
    await user.type(screen.getByLabelText(/^Email/), 'ada@example.test');
    await user.click(screen.getByLabelText(/I agree to be contacted/));
    await user.click(screen.getByRole('button', { name: 'Send' }));
}

type Call = { url: string; init?: RequestInit };

describe('FormBlock', () => {
    let calls: Call[];
    let postStatus: number;

    beforeEach(() => {
        calls = [];
        postStatus = 202;
        vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
            calls.push({ url, init });
            if (!init || init.method !== 'POST') {
                return new Response(JSON.stringify({ token: 'tok', issuedAt: 123, serverNow: 9123 }), { status: 200 });
            }
            return new Response(JSON.stringify({ accepted: true }), { status: postStatus });
        }));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('keeps the grey surface without a stored variant and goes flat on an explicit default', () => {
        const { container, unmount } = renderForm();
        expect(container.querySelector('section.cms-form-block')?.classList.contains('alt-bg')).toBe(true);
        unmount();
        const flat = renderForm({ ...DATA, backgroundVariant: 'default' } as typeof DATA);
        expect(flat.container.querySelector('section.cms-form-block')?.classList.contains('alt-bg')).toBe(false);
    });

    it('does not post while required answers or consent are missing', async () => {
        const user = userEvent.setup();
        renderForm();
        await waitFor(() => expect(calls).toHaveLength(1));
        await user.click(screen.getByRole('button', { name: 'Send' }));
        expect((await screen.findAllByRole('alert')).length).toBeGreaterThanOrEqual(3);
        expect(calls.filter(c => c.init?.method === 'POST')).toHaveLength(0);
    });

    it('posts the answers with the token, the consent and an empty honeypot, then shows the confirmation', async () => {
        const user = userEvent.setup();
        renderForm();
        await waitFor(() => expect(calls).toHaveLength(1));
        await fillAndSend(user);
        expect(await screen.findByText('Thank you')).toBeInTheDocument();
        const post = calls.find(c => c.init?.method === 'POST');
        expect(post?.url).toContain('/api/cms/forms/blk_1');
        const body = JSON.parse(String(post?.init?.body));
        expect(body).toMatchObject({
            token: 'tok', issuedAt: 123, ref_code_2: '', consent: true,
            answers: { name: 'Ada', email: 'ada@example.test' },
        });
        expect(typeof body.nonce).toBe('string');
    });

    it('shows the server\'s per-field messages on a 400', async () => {
        postStatus = 400;
        (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string, init?: RequestInit) => {
            calls.push({ url, init });
            if (!init || init.method !== 'POST') return new Response(JSON.stringify({ token: 'tok', issuedAt: 1, serverNow: 9001 }), { status: 200 });
            return new Response(JSON.stringify({ details: { fields: [{ field: 'email', message: 'Email is not valid.' }] } }), { status: 400 });
        });
        const user = userEvent.setup();
        renderForm();
        await waitFor(() => expect(calls).toHaveLength(1));
        await fillAndSend(user);
        expect(await screen.findByText('Email is not valid.')).toBeInTheDocument();
        expect(screen.getByText('Something went wrong.')).toBeInTheDocument();
    });

    it('uses a new nonce for the resend after the server refused the first try', async () => {
        const nonces: string[] = [];
        let refuse = true;
        (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string, init?: RequestInit) => {
            calls.push({ url, init });
            if (!init || init.method !== 'POST') return new Response(JSON.stringify({ token: 'tok', issuedAt: 1, serverNow: 9001 }), { status: 200 });
            nonces.push(JSON.parse(String(init.body)).nonce);
            const was = refuse;
            refuse = false;
            return new Response('{}', { status: was ? 400 : 202 });
        });
        const user = userEvent.setup();
        renderForm();
        await waitFor(() => expect(calls).toHaveLength(1));
        await fillAndSend(user);
        await screen.findByText('Something went wrong.');
        await user.click(screen.getByRole('button', { name: 'Send' }));
        expect(await screen.findByText('Thank you')).toBeInTheDocument();
        expect(nonces).toHaveLength(2);
        expect(nonces[0]).not.toBe(nonces[1]);
    });
});

describe('FormBlock when the form cannot be shown', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('says the form is unavailable when the server does not know it', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
        renderForm();
        expect(await screen.findByText('This form is not available right now.')).toBeInTheDocument();
    });

    it('renders nothing when the block is disabled', () => {
        const { container } = renderForm({ ...DATA, enabled: false });
        expect(container).toBeEmptyDOMElement();
    });
});
