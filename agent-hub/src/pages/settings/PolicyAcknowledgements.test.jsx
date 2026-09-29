import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Characterisation of the member-facing ISMS policy acknowledgements panel
 * (Settings → Security, bottom of the page).
 *
 * This screen produces EVIDENCE: "this person read this exact version of this
 * policy". So these tests pin, in order of importance, (a) when the panel is
 * visible at all, (b) what an unknown / non-boolean acknowledgement status
 * looks like, and (c) whether the confirm button can be pressed for a policy
 * whose text never appeared on screen.
 *
 * Nothing here judges the behaviour. Where today's behaviour is a wart the
 * test NAME says so.
 *
 * No i18n mock: the global setup awaits ensureI18nDefaults(), so the real
 * hook's provider-less fallback resolves against the full EN catalogue — every
 * string asserted here is the string a user actually reads.
 */

vi.mock('../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

import PolicyAcknowledgements from './PolicyAcknowledgements';
import { authFetch } from '../../utils/helpers';

const jsonRes = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
});

const LIST_URL = '/api/compliance/iso/docs/published/me';

const DOC = {
    slug: 'information-security-policy',
    title: 'Information Security Policy',
    current_version: 3,
    acknowledged: false,
    acknowledged_at: null,
};

/**
 * Route the three calls the panel makes. `list` may be a function so a test
 * can serve a different payload on the refresh after a confirm.
 */
function serve({ list = jsonRes([DOC]), body = jsonRes({ body: '# Policy body' }), ack = jsonRes({ ok: true }) } = {}) {
    let listCall = 0;
    authFetch.mockImplementation(async (url, opts = {}) => {
        const u = String(url);
        if (opts.method === 'POST') return typeof ack === 'function' ? ack(u) : ack;
        if (u.endsWith(LIST_URL)) return typeof list === 'function' ? list(listCall++) : list;
        if (u.endsWith('/body')) return typeof body === 'function' ? body(u) : body;
        throw new Error(`unrouted call: ${u}`);
    });
}

const listCalls = () => authFetch.mock.calls.filter(c => String(c[0]).endsWith(LIST_URL));
const bodyCalls = () => authFetch.mock.calls.filter(c => String(c[0]).endsWith('/body'));
const postCalls = () => authFetch.mock.calls.filter(c => c[1]?.method === 'POST');

/** Mount and wait until the first list call has resolved into a render. */
async function mount(opts) {
    serve(opts);
    const view = render(<PolicyAcknowledgements />);
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
    return view;
}

/** A promise whose resolution the test controls. */
function deferred() {
    let resolve;
    const promise = new Promise(res => { resolve = res; });
    return { promise, resolve };
}

const rowFor = (title) => screen.getByText(title, { exact: false }).closest('div.rounded-lg');

beforeEach(() => { cleanup(); vi.clearAllMocks(); });

describe('PolicyAcknowledgements — when the panel is visible at all', () => {
    it('renders nothing at all before the first response lands', () => {
        authFetch.mockImplementation(() => new Promise(() => {}));
        const { container } = render(<PolicyAcknowledgements />);
        expect(container).toBeEmptyDOMElement();
    });

    it('renders nothing when the org has no published policies', async () => {
        const { container } = await mount({ list: jsonRes([]) });
        await waitFor(() => expect(container).toBeEmptyDOMElement());
        expect(screen.queryByText('Organisation policies')).toBeNull();
    });

    it('asks exactly one endpoint on mount: the published-for-me list', async () => {
        await mount();
        await screen.findByText('Organisation policies');
        expect(listCalls()).toHaveLength(1);
        expect(String(listCalls()[0][0])).toBe('/api/compliance/iso/docs/published/me');
        expect(listCalls()[0][1]).toBeUndefined();
    });

    it('stays completely invisible on 402 (unlicensed) — the documented case', async () => {
        const { container } = await mount({ list: jsonRes({ error: 'unlicensed' }, 402) });
        await waitFor(() => expect(container).toBeEmptyDOMElement());
    });

    it('stays completely invisible on 500 too, with no error shown (securityFinding: a server fault silently removes the acknowledgement obligation)', async () => {
        const { container } = await mount({ list: jsonRes({ error: 'boom' }, 500) });
        await waitFor(() => expect(container).toBeEmptyDOMElement());
        // Not "could not load policies", not a retry — nothing at all.
        expect(screen.queryByText(/polic/i)).toBeNull();
        expect(listCalls()).toHaveLength(1);
    });

    it('stays invisible when the network call rejects', async () => {
        authFetch.mockRejectedValue(new Error('offline'));
        const { container } = render(<PolicyAcknowledgements />);
        await waitFor(() => expect(authFetch).toHaveBeenCalled());
        await waitFor(() => expect(container).toBeEmptyDOMElement());
    });

    it('stays invisible when the payload is not an array (wart: a 200 with an object body is treated as "no policies")', async () => {
        const { container } = await mount({ list: jsonRes({ docs: [DOC] }) });
        await waitFor(() => expect(container).toBeEmptyDOMElement());
    });
});

describe('PolicyAcknowledgements — the list', () => {
    it('shows the panel heading and description once a policy exists', async () => {
        await mount();
        expect(await screen.findByRole('heading', { name: 'Organisation policies' })).toBeInTheDocument();
        expect(screen.getByText('Policies your organisation asks you to read and confirm.')).toBeInTheDocument();
    });

    it('shows every policy title with its current version prefixed by "v"', async () => {
        await mount({
            list: jsonRes([
                { ...DOC, slug: 'a', title: 'Information Security Policy', current_version: 3 },
                { ...DOC, slug: 'b', title: 'Acceptable Use Policy', current_version: 11 },
            ]),
        });
        expect(await screen.findByText('Acceptable Use Policy', { exact: false })).toBeInTheDocument();
        expect(screen.getByText('v3')).toBeInTheDocument();
        expect(screen.getByText('v11')).toBeInTheDocument();
    });

    it('shows "Read policy" in amber when the policy is not acknowledged', async () => {
        await mount({ list: jsonRes([{ ...DOC, acknowledged: false }]) });
        const badge = await screen.findByText('Read policy');
        expect(badge).toHaveClass('text-amber-500');
    });

    it('shows "Confirmed <date>" in green when acknowledged, using the local date of acknowledged_at', async () => {
        const at = '2026-08-01T10:00:00Z';
        await mount({ list: jsonRes([{ ...DOC, acknowledged: true, acknowledged_at: at }]) });
        const badge = await screen.findByText(`Confirmed ${new Date(at).toLocaleDateString()}`);
        expect(badge).toHaveClass('text-green-600');
        expect(screen.queryByText('Read policy')).toBeNull();
    });

    it('renders a bare "Confirmed" when acknowledged is true but acknowledged_at is missing', async () => {
        await mount({ list: jsonRes([{ ...DOC, acknowledged: true, acknowledged_at: null }]) });
        const row = await screen.findByRole('button');
        expect(row.textContent).toContain('Confirmed');
        expect(row.textContent).not.toMatch(/Confirmed\s+\S/);
    });

    it('reads a MISSING acknowledged field as not-yet-confirmed', async () => {
        const { acknowledged: _drop, ...noStatus } = DOC;
        await mount({ list: jsonRes([noStatus]) });
        expect(await screen.findByText('Read policy')).toBeInTheDocument();
    });

    it('reads any truthy non-boolean status as CONFIRMED — the string "false" included (securityFinding)', async () => {
        await mount({ list: jsonRes([{ ...DOC, acknowledged: 'false', acknowledged_at: null }]) });
        const row = await screen.findByRole('button');
        expect(row.textContent).toContain('Confirmed');
        expect(screen.queryByText('Read policy')).toBeNull();
    });
});

describe('PolicyAcknowledgements — reading a policy body', () => {
    it('fetches the body of the clicked slug and renders it', async () => {
        await mount({ body: jsonRes({ body: 'All laptops must be encrypted.' }) });
        fireEvent.click(await screen.findByRole('button'));
        expect(await screen.findByText('All laptops must be encrypted.')).toBeInTheDocument();
        expect(String(bodyCalls()[0][0]))
            .toBe('/api/compliance/iso/docs/published/information-security-policy/body');
    });

    it('URL-encodes the slug on the body request', async () => {
        await mount({ list: jsonRes([{ ...DOC, slug: 'a b/c' }]) });
        fireEvent.click(await screen.findByRole('button'));
        await waitFor(() => expect(bodyCalls()).toHaveLength(1));
        expect(String(bodyCalls()[0][0])).toBe('/api/compliance/iso/docs/published/a%20b%2Fc/body');
    });

    it('shows a spinner while the body is in flight', async () => {
        const d = deferred();
        await mount({ body: () => d.promise });
        const { container } = { container: document.body };
        fireEvent.click(await screen.findByRole('button'));
        await waitFor(() => expect(container.querySelector('.animate-spin')).not.toBeNull());
        d.resolve(jsonRes({ body: 'text' }));
        expect(await screen.findByText('text')).toBeInTheDocument();
        expect(container.querySelector('.animate-spin')).toBeNull();
    });

    it('spins FOREVER when the body request fails — no error, no retry (wart)', async () => {
        await mount({ body: jsonRes({ error: 'nope' }, 500) });
        fireEvent.click(await screen.findByRole('button'));
        await waitFor(() => expect(bodyCalls()).toHaveLength(1));
        await waitFor(() => expect(document.body.querySelector('.animate-spin')).not.toBeNull());
        expect(screen.queryByText(/could not|failed|error/i)).toBeNull();
    });

    it('offers the confirm button even though the body never loaded — a policy can be acknowledged unseen (securityFinding)', async () => {
        await mount({ body: jsonRes({ error: 'nope' }, 500) });
        fireEvent.click(await screen.findByRole('button'));
        const confirm = await screen.findByRole('button', { name: /I have read and understood this policy/ });
        expect(confirm).toBeEnabled();
        expect(document.body.querySelector('.animate-spin')).not.toBeNull();

        fireEvent.click(confirm);
        await waitFor(() => expect(postCalls()).toHaveLength(1));
        expect(String(postCalls()[0][0]))
            .toBe('/api/compliance/iso/docs/information-security-policy/acknowledge');
    });

    it('offers the confirm button when the body request rejects outright (securityFinding)', async () => {
        serve();
        authFetch.mockImplementation(async (url, opts = {}) => {
            const u = String(url);
            if (opts.method === 'POST') return jsonRes({ ok: true });
            if (u.endsWith('/body')) throw new Error('offline');
            return jsonRes([DOC]);
        });
        render(<PolicyAcknowledgements />);
        fireEvent.click(await screen.findByRole('button'));
        expect(await screen.findByRole('button', { name: /I have read and understood this policy/ })).toBeEnabled();
    });

    it('clicking the same policy again collapses it and drops the body', async () => {
        await mount({ body: jsonRes({ body: 'chapter one' }) });
        const header = await screen.findByRole('button');
        fireEvent.click(header);
        expect(await screen.findByText('chapter one')).toBeInTheDocument();
        fireEvent.click(header);
        await waitFor(() => expect(screen.queryByText('chapter one')).toBeNull());
        expect(screen.queryByRole('button', { name: /I have read and understood/ })).toBeNull();
        // Re-opening refetches; the body is not cached.
        fireEvent.click(header);
        await waitFor(() => expect(bodyCalls()).toHaveLength(2));
    });

    it('opening a second policy drops the first body immediately, back to a spinner, before the new one lands', async () => {
        const slowB = deferred();
        await mount({
            list: jsonRes([
                { ...DOC, slug: 'a', title: 'Policy A' },
                { ...DOC, slug: 'b', title: 'Policy B' },
            ]),
            body: (u) => (u.includes('/a/') ? jsonRes({ body: 'body of A' }) : slowB.promise),
        });
        fireEvent.click(within(rowFor('Policy A')).getByRole('button'));
        expect(await screen.findByText('body of A')).toBeInTheDocument();

        fireEvent.click(within(rowFor('Policy B')).getByRole('button'));
        // Synchronously, before B answers: A's text is gone and a spinner is up.
        expect(screen.queryByText('body of A')).toBeNull();
        expect(document.body.querySelector('.animate-spin')).not.toBeNull();

        slowB.resolve(jsonRes({ body: 'body of B' }));
        expect(await screen.findByText('body of B')).toBeInTheDocument();
        expect(screen.queryByText('body of A')).toBeNull();
    });

    it('a slow first body lands under the SECOND policy — no request is cancelled or keyed (wart)', async () => {
        const slowA = deferred();
        await mount({
            list: jsonRes([
                { ...DOC, slug: 'a', title: 'Policy A' },
                { ...DOC, slug: 'b', title: 'Policy B' },
            ]),
            body: (u) => (u.includes('/a/') ? slowA.promise : jsonRes({ body: 'body of B' })),
        });
        fireEvent.click(within(rowFor('Policy A')).getByRole('button'));
        fireEvent.click(within(rowFor('Policy B')).getByRole('button'));
        expect(await screen.findByText('body of B')).toBeInTheDocument();

        slowA.resolve(jsonRes({ body: 'body of A' }));
        // Policy A's text is now rendered inside Policy B's expanded panel.
        expect(await screen.findByText('body of A')).toBeInTheDocument();
        expect(within(rowFor('Policy B')).getByText('body of A')).toBeInTheDocument();
    });
});

describe('PolicyAcknowledgements — confirming', () => {
    const openFirst = async () => {
        const header = await screen.findByRole('button');
        fireEvent.click(header);
        return screen.findByRole('button', { name: /I have read and understood this policy/ });
    };

    it('POSTs an empty JSON body to the acknowledge endpoint of that slug', async () => {
        await mount();
        fireEvent.click(await openFirst());
        await waitFor(() => expect(postCalls()).toHaveLength(1));
        const [url, opts] = postCalls()[0];
        expect(String(url)).toBe('/api/compliance/iso/docs/information-security-policy/acknowledge');
        expect(opts).toMatchObject({ method: 'POST', body: '{}' });
        expect(opts.headers).toEqual({ 'Content-Type': 'application/json' });
    });

    it('URL-encodes the slug on the acknowledge endpoint', async () => {
        await mount({ list: jsonRes([{ ...DOC, slug: 'a b/c' }]) });
        fireEvent.click(await openFirst());
        await waitFor(() => expect(postCalls()).toHaveLength(1));
        expect(String(postCalls()[0][0])).toBe('/api/compliance/iso/docs/a%20b%2Fc/acknowledge');
    });

    it('re-reads the list after a successful confirm and flips the badge', async () => {
        await mount({
            list: (n) => jsonRes([n === 0
                ? { ...DOC, acknowledged: false }
                : { ...DOC, acknowledged: true, acknowledged_at: '2026-09-06T09:00:00Z' }]),
        });
        fireEvent.click(await openFirst());
        await waitFor(() => expect(listCalls()).toHaveLength(2));
        expect(await screen.findByText(`Confirmed ${new Date('2026-09-06T09:00:00Z').toLocaleDateString()}`)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /I have read and understood/ })).toBeNull();
    });

    it('disables the confirm button while the POST is in flight', async () => {
        const d = deferred();
        await mount({ ack: () => d.promise });
        const confirm = await openFirst();
        fireEvent.click(confirm);
        await waitFor(() => expect(confirm).toBeDisabled());
        d.resolve(jsonRes({ ok: true }));
        await waitFor(() => expect(listCalls()).toHaveLength(2));
    });

    /*
     * NOT PINNED HERE, deliberately: confirm() wraps its POST in try/finally
     * with NO catch (source lines 46-53), so a REJECTED authFetch escapes as an
     * unhandled promise rejection. Asserting on that from a test would leave an
     * unhandled rejection in every run — reported as a wart instead. The
     * non-ok path below is the observable half of the same silence.
     */
    it('a failed (non-ok) confirm leaves the row unacknowledged with no feedback (wart)', async () => {
        await mount({ ack: jsonRes({ error: 'denied' }, 403) });
        const confirm = await openFirst();
        fireEvent.click(confirm);
        await waitFor(() => expect(postCalls()).toHaveLength(1));
        await waitFor(() => expect(confirm).toBeEnabled());
        expect(listCalls()).toHaveLength(1);
        expect(screen.getByText('Read policy')).toBeInTheDocument();
    });

    it('never renders a confirm button for an already-acknowledged policy', async () => {
        await mount({ list: jsonRes([{ ...DOC, acknowledged: true, acknowledged_at: '2026-08-01T10:00:00Z' }]) });
        fireEvent.click(await screen.findByRole('button'));
        expect(await screen.findByText('# Policy body')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /I have read and understood/ })).toBeNull();
    });
});
