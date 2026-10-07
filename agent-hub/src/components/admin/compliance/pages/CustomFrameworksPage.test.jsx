import { render, screen, fireEvent, cleanup, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { evidenceRef, attestErrorText } from './custom/AttestDrawer';
import { indexResults, joinChecks, statusPill, groupBuiltinChecks } from './custom/CustomChecksTable';
import { toBody, validate, CODE_RE, editorErrorText } from './custom/FrameworkEditorDrawer';
import { parseQuestionnaire, splitLine, detectDelimiter } from './custom/QuestionnaireImport';
import CustomFrameworksPage, { normaliseFramework, normaliseList, expiringCount, OUTCOMES } from './CustomFrameworksPage';

vi.mock('../../../../hooks/useTranslation', () => {
    // The built-in check titles the "Satisfied by" picker translates.
    const DICT = {
        'compliance.test_check_records': 'Principles of processing',
        'compliance.test_check_ropa': 'Processing register kept',
        'compliance.test_check_breach': 'Breaches detected and reported',
        'compliance.test_check_disclosure': 'AI disclosure to users',
    };
    const useTranslation = () => ({
        t: (key, fallback, params) => {
            let out = DICT[key] ?? (typeof fallback === 'string' ? fallback : key);
            for (const [k, v] of Object.entries(params || {})) out = out.split(`{${k}}`).join(String(v));
            return out;
        },
        locale: 'en',
        resolvedLocale: 'en',
    });
    return { default: useTranslation, useTranslation };
});

const fetchJson = vi.fn();
vi.mock('../data/api', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, fetchJson: (...args) => fetchJson(...args) };
});

afterEach(cleanup);
beforeEach(() => { fetchJson.mockReset(); });

const NOW = new Date('2026-09-14T10:00:00Z').getTime();

const customRows = () => ([
    {
        id: 'custom:11111111-1111-4111-8111-111111111111', custom_id: '11111111-1111-4111-8111-111111111111',
        code: 'NIS2_KLANT', name: 'Customer NIS2 questionnaire', reference: 'Acme supplier pack', status: 'active',
        attestation_valid_months: 12, checks_count: 3, attested_count: 2, enabled: true, core: false, locked: null, score: 67,
    },
    {
        id: 'custom:22222222-2222-4222-8222-222222222222', custom_id: '22222222-2222-4222-8222-222222222222',
        code: 'BRANCHE', name: 'Sector code', reference: null, status: 'draft',
        attestation_valid_months: 24, checks_count: 0, attested_count: 0, enabled: false, core: false, locked: null, score: null,
    },
]);

const coreChecks = () => ([
    { check_id: 'CUSTOM-NIS2_KLANT-1', regulation: 'CUSTOM', framework_code: 'NIS2_KLANT', article: '1', status: 'pass', evidence: { expires_at: '2027-05-01T00:00:00Z' } },
    { check_id: 'CUSTOM-NIS2_KLANT-2', regulation: 'CUSTOM', framework_code: 'NIS2_KLANT', article: '2', status: 'warn', evidence: { expires_at: '2026-09-20T00:00:00Z' } },
    { check_id: 'CUSTOM-NIS2_KLANT-3', regulation: 'CUSTOM', framework_code: 'NIS2_KLANT', article: '3', status: 'fail', evidence: null },
    { check_id: 'GDPR-Art30-ropa', regulation: 'GDPR', article: '30', status: 'pass' },
]);

const detailBody = () => ({
    id: '11111111-1111-4111-8111-111111111111', code: 'NIS2_KLANT', name: 'Customer NIS2 questionnaire', status: 'active',
    attestation_valid_months: 12,
    checks: [
        { id: 'c1', ref: '1', title: 'Security policy', description: 'Is there a policy?', severity: 'high', evidence_required: true, mapped_check_id: null, sort_order: 0 },
        { id: 'c2', ref: '2', title: 'Incident notification term', description: null, severity: 'medium', evidence_required: false, mapped_check_id: null, sort_order: 1 },
        { id: 'c3', ref: '3', title: 'Processing register', description: null, severity: 'low', evidence_required: false, mapped_check_id: 'GDPR-Art30-ropa', sort_order: 2 },
    ],
});

const registryBody = () => ({
    checks: [
        { id: 'AIA-Art50-ai-disclosure', regulation: 'AIA', article: '50', titleKey: 'compliance.test_check_disclosure' },
        { id: 'GDPR-Art33-breach-detection', regulation: 'GDPR', article: '33', titleKey: 'compliance.test_check_breach' },
        { id: 'GDPR-Art30-ropa', regulation: 'GDPR', article: '30', titleKey: 'compliance.test_check_ropa' },
        { id: 'GDPR-Art5-principles', regulation: 'GDPR', article: '5', titleKey: 'compliance.test_check_records' },
    ],
});

/** "New framework" is the header's primary action: call what the page handed the header. */
function newFromHeader(p) {
    const actions = p.setHeaderActions.mock.calls.map(c => c[0]).filter(a => a && a.onAddFramework);
    act(() => { actions[actions.length - 1].onAddFramework(); });
}

function pageProps(over = {}) {
    return {
        section: { id: 'custom' },
        navigate: vi.fn(),
        setHeaderActions: vi.fn(),
        exportsEnabled: true,
        dl: (url) => url,
        isMobile: false,
        now: NOW,
        data: {
            core: { checks: over.checks ?? coreChecks(), refresh: vi.fn(() => Promise.resolve()) },
            bump: vi.fn(),
            frameworks: { custom: over.custom === undefined ? customRows() : over.custom, refresh: vi.fn(() => Promise.resolve()) },
        },
        ...(over.props || {}),
    };
}

describe('CustomFrameworksPage — list', () => {
    it('renders a card per framework with its score ring, items and what expires soon', () => {
        render(<CustomFrameworksPage {...pageProps()} />);
        const cards = screen.getAllByTestId('custom-card');
        expect(cards.map(c => c.dataset.framework)).toEqual([
            '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
        ]);
        const rings = screen.getAllByTestId('custom-card-score');
        expect(rings[0].dataset.score).toBe('67');
        expect(rings[1].dataset.placeholder).toBe('true');
        expect(cards[0].textContent).toContain('3 items');
        expect(cards[0].textContent).toContain('1 expiring');
        expect(cards[1].querySelector('[data-testid="custom-card-expiring"]')).toBeNull();
        expect(screen.getAllByTestId('custom-card-status')[1].textContent).toBe('Draft');
    });

    it('offers the new-framework action to the header (its primary), not as a second button on the page', () => {
        const p = pageProps();
        render(<CustomFrameworksPage {...p} />);
        expect(p.setHeaderActions).toHaveBeenCalledWith(expect.objectContaining({ onAddFramework: expect.any(Function) }));
        expect(screen.queryByTestId('custom-new')).toBeNull();
        newFromHeader(p);
        expect(screen.getByTestId('custom-editor-title').textContent).toBe('New framework');
        expect(screen.getByTestId('custom-editor-code').disabled).toBe(false);
    });

    it('falls back to GET /custom/frameworks when the hub carries no custom rows, and a failed read is its own state', async () => {
        fetchJson.mockResolvedValueOnce([{ id: '33333333-3333-4333-8333-333333333333', code: 'OWN', name: 'Own', status: 'draft', checks_count: 1 }]);
        const { unmount } = render(<CustomFrameworksPage {...pageProps({ custom: null })} />);
        await waitFor(() => expect(screen.getAllByTestId('custom-card').length).toBe(1));
        expect(fetchJson.mock.calls[0][0]).toMatch(/\/custom\/frameworks$/);
        unmount();

        fetchJson.mockReset();
        fetchJson.mockRejectedValueOnce(new Error('403 feature_locked'));
        render(<CustomFrameworksPage {...pageProps({ custom: null })} />);
        await waitFor(() => expect(screen.getByTestId('custom-list-failed')).toBeTruthy());
        expect(screen.queryByTestId('custom-grid')).toBeNull();
    });

    it('no frameworks at all is an empty state, not a failure', () => {
        render(<CustomFrameworksPage {...pageProps({ custom: [] })} />);
        expect(screen.getByTestId('custom-empty')).toBeTruthy();
        expect(screen.queryByTestId('custom-card')).toBeNull();
    });

    it('creating a framework POSTs and opens the new framework', async () => {
        fetchJson
            .mockResolvedValueOnce({ id: '44444444-4444-4444-8444-444444444444', code: 'NEW', name: 'New one' })  // POST
            .mockResolvedValueOnce({ id: '44444444-4444-4444-8444-444444444444', code: 'NEW', checks: [] });      // detail
        const p = pageProps();
        render(<CustomFrameworksPage {...p} />);
        newFromHeader(p);
        fireEvent.change(screen.getByTestId('custom-editor-name'), { target: { value: 'New one' } });
        fireEvent.change(screen.getByTestId('custom-editor-code'), { target: { value: 'new_one' } });
        fireEvent.click(screen.getByTestId('custom-editor-save'));
        await waitFor(() => expect(fetchJson).toHaveBeenCalled());
        const [url, init] = fetchJson.mock.calls[0];
        expect(url).toMatch(/\/custom\/frameworks$/);
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toMatchObject({ name: 'New one', code: 'NEW_ONE', attestation_valid_months: 12, status: 'draft' });
        await waitFor(() => expect(p.data.frameworks.refresh).toHaveBeenCalled());
    });

    it('a refused code is shown in the editor and the drawer stays open', async () => {
        fetchJson.mockRejectedValueOnce(new Error('409 custom_framework_code_taken'));
        const p = pageProps();
        render(<CustomFrameworksPage {...p} />);
        newFromHeader(p);
        fireEvent.change(screen.getByTestId('custom-editor-name'), { target: { value: 'Duplicate' } });
        fireEvent.change(screen.getByTestId('custom-editor-code'), { target: { value: 'NIS2_KLANT' } });
        fireEvent.click(screen.getByTestId('custom-editor-save'));
        await waitFor(() => expect(screen.getByTestId('custom-editor-error').textContent).toBe('That code is already in use.'));
        expect(screen.getByTestId('custom-editor-title')).toBeTruthy();
    });
});

describe('CustomFrameworksPage — detail', () => {
    async function openFirst(over = {}) {
        fetchJson
            .mockResolvedValueOnce(detailBody())
            .mockResolvedValueOnce(registryBody());
        const p = pageProps(over);
        render(<CustomFrameworksPage {...p} />);
        fireEvent.click(screen.getAllByTestId('custom-card')[0]);
        await waitFor(() => expect(screen.getAllByTestId('custom-checks-row').length).toBe(3));
        return p;
    }

    it('loads the items, joins them with the runner results and offers the export pack', async () => {
        await openFirst();
        expect(fetchJson.mock.calls[0][0]).toMatch(/\/custom\/frameworks\/11111111-1111-4111-8111-111111111111$/);
        expect(screen.getByTestId('custom-detail-name').textContent).toBe('Customer NIS2 questionnaire');
        expect(screen.getAllByTestId('custom-checks-ref').map(el => el.textContent)).toEqual(['1', '2', '3']);
        expect(screen.getAllByTestId('custom-checks-status').map(el => el.textContent))
            .toEqual(['Satisfied', 'Attention', 'Not satisfied']);
        expect(screen.getByTestId('custom-export').getAttribute('href')).toMatch(/\/custom\/frameworks\/11111111-1111-4111-8111-111111111111\/export\.json$/);
    });

    it('the "satisfied by" picker is fed from GET /registry and a mapped item cannot be attested by hand', async () => {
        await openFirst();
        expect(fetchJson.mock.calls[1][0]).toMatch(/\/registry$/);
        const selects = screen.getAllByTestId('custom-checks-mapped');
        // grouped by law in the rail's order, sorted by article (5 before 30), the id only as a tooltip
        expect([...selects[0].options].map(o => o.value)).toEqual(['', 'GDPR-Art5-principles', 'GDPR-Art30-ropa', 'GDPR-Art33-breach-detection', 'AIA-Art50-ai-disclosure']);
        expect([...selects[0].querySelectorAll('optgroup')].map(g => g.label)).toEqual(['GDPR', 'AI Act']);
        const gdpr = selects[0].querySelector('optgroup[label="GDPR"]');
        expect([...gdpr.querySelectorAll('option')].map(o => o.textContent)).toEqual([
            'Art. 5 · Principles of processing', 'Art. 30 · Processing register kept', 'Art. 33 · Breaches detected and reported',
        ]);
        expect(gdpr.querySelector('option').getAttribute('title')).toBe('GDPR-Art5-principles');
        expect([...selects[0].options].some(o => o.textContent === 'GDPR-Art30-ropa')).toBe(false);
        expect(selects[2].value).toBe('GDPR-Art30-ropa');
        const attestButtons = screen.getAllByTestId('custom-checks-attest');
        expect(attestButtons[0].disabled).toBe(false);
        expect(attestButtons[2].disabled).toBe(true);
    });

    it('delete asks first: "Delete this item?" — Cancel keeps the item, Delete removes it', async () => {
        const user = userEvent.setup();
        await openFirst();
        const row = screen.getAllByTestId('custom-checks-row')[0];
        await user.click(within(row).getByTestId('custom-checks-delete'));
        const confirm = within(row).getByTestId('custom-checks-delete-confirm');
        expect(confirm.getAttribute('role')).toBe('group');
        expect(confirm).toHaveTextContent('Delete this item?');
        expect(within(row).getByTestId('custom-checks-delete-yes')).toHaveFocus();
        expect(fetchJson.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);

        await user.click(within(row).getByTestId('custom-checks-delete-cancel'));
        expect(within(row).queryByTestId('custom-checks-delete-confirm')).toBeNull();
        expect(within(row).getByTestId('custom-checks-delete')).toHaveFocus();
        expect(fetchJson.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);

        // Escape backs out too
        await user.click(within(row).getByTestId('custom-checks-delete'));
        await user.keyboard('{Escape}');
        expect(within(row).queryByTestId('custom-checks-delete-confirm')).toBeNull();

        fetchJson.mockResolvedValue({});
        await user.click(within(row).getByTestId('custom-checks-delete'));
        await user.click(within(row).getByTestId('custom-checks-delete-yes'));
        await waitFor(() => expect(fetchJson.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true));
        const [url] = fetchJson.mock.calls.find(([, init]) => init?.method === 'DELETE');
        expect(url).toMatch(/\/custom\/checks\/c1$/);
    });

    it('the "Satisfied by" column is an action: it never folds away', async () => {
        await openFirst();
        const header = screen.getAllByRole('columnheader').find(h => h.textContent === 'Satisfied by');
        expect(header.className).not.toMatch(/hidden/);
    });

    it('choosing a built-in check upserts the row through the bulk route', async () => {
        await openFirst();
        fetchJson.mockResolvedValue({ checks: [], count: 0 });
        fireEvent.change(screen.getAllByTestId('custom-checks-mapped')[1], { target: { value: 'GDPR-Art33-breach-detection' } });
        await waitFor(() => expect(fetchJson.mock.calls.length).toBeGreaterThan(2));
        const [url, init] = fetchJson.mock.calls[2];
        expect(url).toMatch(/\/custom\/frameworks\/11111111-1111-4111-8111-111111111111\/checks$/);
        expect(JSON.parse(init.body).checks[0]).toMatchObject({ ref: '2', mapped_check_id: 'GDPR-Art33-breach-detection' });
    });

    it('pasting a questionnaire previews the parsed rows and bulk-posts them', async () => {
        await openFirst();
        fireEvent.click(screen.getByTestId('custom-import-open'));
        fireEvent.change(screen.getByTestId('custom-import-text'), {
            target: { value: 'ref;title;description;severity;evidence\nA.1;Policy;;high;1\nA.2;Roles;;bogus;0\n;no ref' },
        });
        expect(screen.getByTestId('custom-import-preview').textContent).toContain('2 items recognised');
        expect(screen.getByTestId('custom-import-preview').textContent).toContain('1 lines skipped');
        fetchJson.mockResolvedValue({ checks: [], count: 2 });
        fireEvent.click(screen.getByTestId('custom-import-submit'));
        await waitFor(() => expect(fetchJson.mock.calls.length).toBeGreaterThan(2));
        const body = JSON.parse(fetchJson.mock.calls[2][1].body);
        expect(body.checks).toEqual([
            { ref: 'A.1', title: 'Policy', description: null, severity: 'high', evidence_required: true },
            { ref: 'A.2', title: 'Roles', description: null, severity: 'medium', evidence_required: false },
        ]);
    });

    it('attesting an item loads its history and refuses to record without evidence when the item demands it', async () => {
        await openFirst();
        fetchJson.mockResolvedValueOnce([{ id: 'h1', outcome: 'partial', attested_at: '2026-03-01T00:00:00Z' }]);
        fireEvent.click(screen.getAllByTestId('custom-checks-attest')[0]);
        await waitFor(() => expect(screen.getByTestId('custom-attest-drawer-history-row')).toBeTruthy());
        expect(fetchJson.mock.calls[2][0]).toMatch(/\/custom\/checks\/c1\/attestations$/);
        expect(screen.getByTestId('custom-attest-drawer-history-row').textContent).toContain('Partly compliant');
        expect(screen.getByTestId('custom-attest-drawer-ref').textContent).toBe('NIS2_KLANT · 1');

        // item 1 has evidence_required: picking an outcome is not enough
        fireEvent.click(screen.getAllByTestId('custom-attest-drawer-option')[0]);
        expect(screen.getByTestId('custom-attest-drawer-evidence-warning')).toBeTruthy();
        expect(screen.getByTestId('custom-attest-drawer-submit').disabled).toBe(true);
    });

    it('an item without an evidence demand records straight away', async () => {
        await openFirst();
        fetchJson.mockResolvedValueOnce([]);                       // history
        fireEvent.click(screen.getAllByTestId('custom-checks-attest')[1]);
        await waitFor(() => expect(screen.getByTestId('custom-attest-drawer-history-empty')).toBeTruthy());
        expect(screen.queryByTestId('custom-attest-drawer-evidence-warning')).toBeNull();
        fireEvent.click(screen.getAllByTestId('custom-attest-drawer-option')[2]);
        fetchJson.mockResolvedValue({ id: 'a1', outcome: 'non_compliant' });
        fireEvent.click(screen.getByTestId('custom-attest-drawer-submit'));
        await waitFor(() => expect(fetchJson.mock.calls.some(c => /\/custom\/checks\/c2\/attest$/.test(c[0]))).toBe(true));
        const call = fetchJson.mock.calls.find(c => /\/custom\/checks\/c2\/attest$/.test(c[0]));
        expect(JSON.parse(call[1].body)).toEqual({ outcome: 'non_compliant', statement: null, evidence_refs: [] });
    });

    it('a failed item read is its own state and the code stays read-only when editing', async () => {
        fetchJson
            .mockRejectedValueOnce(new Error('500 boom'))
            .mockResolvedValueOnce(registryBody());
        render(<CustomFrameworksPage {...pageProps()} />);
        fireEvent.click(screen.getAllByTestId('custom-card')[0]);
        await waitFor(() => expect(screen.getByTestId('custom-detail-failed')).toBeTruthy());
        fireEvent.click(screen.getByTestId('custom-edit'));
        expect(screen.getByTestId('custom-editor-title').textContent).toBe('Edit framework');
        expect(screen.getByTestId('custom-editor-code').readOnly).toBe(true);
        expect(screen.getByTestId('custom-editor-code').value).toBe('NIS2_KLANT');
        expect(screen.getByTestId('custom-editor-archive')).toBeTruthy();
    });
});

describe('pure helpers', () => {
    it('groupBuiltinChecks: one group per law in rail order, by article, the title as text', () => {
        const t = (key, fallback) => ({ 'compliance.reg_aia': 'AI Act' }[key] ?? fallback);
        const groups = groupBuiltinChecks([
            { id: 'X-1', regulation: 'NOPE', article: '1' },
            ...registryBody().checks,
            null,
            { regulation: 'GDPR', article: '9' },
        ], t);
        expect(groups.map(g => g.label)).toEqual(['GDPR', 'AI Act', 'NOPE']);
        expect(groups[0].checks.map(c => c.id)).toEqual(['GDPR-Art5-principles', 'GDPR-Art30-ropa', 'GDPR-Art33-breach-detection']);
        expect(groups[2].checks[0].label).toBe('Art. 1 · X-1');
        expect(groupBuiltinChecks(null, t)).toEqual([]);
    });

    it('normaliseFramework accepts both the /frameworks row and a bare store row', () => {
        expect(normaliseFramework(customRows()[0])).toMatchObject({ id: '11111111-1111-4111-8111-111111111111', code: 'NIS2_KLANT', score: 67 });
        expect(normaliseFramework({ id: 'abc', code: 'X', name: 'X' })).toMatchObject({ id: 'abc', score: null, checks_count: null });
        expect(normaliseFramework(null)).toBeNull();
        expect(normaliseList('nope')).toBeNull();
        expect(normaliseList([]).length).toBe(0);
    });

    it('expiringCount counts what expires within 30 days, and reads no rows as unknown', () => {
        expect(expiringCount(coreChecks(), 'NIS2_KLANT', NOW)).toBe(1);
        expect(expiringCount(coreChecks(), 'BRANCHE', NOW)).toBeNull();
        expect(expiringCount(null, 'NIS2_KLANT', NOW)).toBeNull();
        expect(expiringCount(coreChecks(), '', NOW)).toBeNull();
    });

    it('indexResults / joinChecks join on framework_code + ref, not on a rebuilt id', () => {
        const idx = indexResults(coreChecks());
        expect(idx.size).toBe(3);
        expect(idx.has('NIS2_KLANT#2')).toBe(true);
        const joined = joinChecks(detailBody().checks, idx, 'NIS2_KLANT');
        expect(joined.map(c => c.result?.status)).toEqual(['pass', 'warn', 'fail']);
        expect(joinChecks(detailBody().checks, idx, 'OTHER').every(c => c.result === null)).toBe(true);
        expect(joinChecks(null, idx, 'NIS2_KLANT')).toBeNull();
        expect(statusPill('pending').tone).toBe('neutral');
        expect(statusPill('nonsense')).toBe(statusPill('pending'));
    });

    it('parseQuestionnaire reads JSON, csv, semicolons and tabs, with or without a header', () => {
        expect(parseQuestionnaire('').rows).toEqual([]);
        expect(parseQuestionnaire('[{"ref":"1","title":"A"}]')).toMatchObject({ format: 'json', rows: [{ ref: '1', title: 'A', severity: 'medium', evidence_required: false }] });
        expect(parseQuestionnaire('{"checks":[{"reference":"2","question":"B","evidenceRequired":true}]}').rows[0])
            .toMatchObject({ ref: '2', title: 'B', evidence_required: true });
        expect(parseQuestionnaire('{"nope":1}').error).toBe('json_shape');
        expect(parseQuestionnaire('[oops').error).toBe('json_invalid');
        expect(parseQuestionnaire('ref,title\nA.1,"Policy, with comma",,critical,yes').rows).toEqual([
            { ref: 'A.1', title: 'Policy, with comma', description: null, severity: 'critical', evidence_required: true },
        ]);
        expect(parseQuestionnaire('A.1\tPolicy\t\tlow\t0').rows[0]).toMatchObject({ ref: 'A.1', severity: 'low' });
        expect(parseQuestionnaire('no title here').error).toBe('no_rows');
    });

    it('splitLine honours quotes and detectDelimiter picks the widest split', () => {
        expect(splitLine('a,"b,c",d', ',')).toEqual(['a', 'b,c', 'd']);
        expect(splitLine('a,"say ""hi""",c', ',')).toEqual(['a', 'say "hi"', 'c']);
        expect(detectDelimiter(['a;b;c;d'])).toBe(';');
        expect(detectDelimiter(['a,b,c,d,e'])).toBe(',');
    });

    it('toBody / validate / CODE_RE / editorErrorText', () => {
        const form = { name: ' Q ', code: ' nis2_k ', reference: '', description: '', months: '12', evergreen: false, status: 'active' };
        expect(toBody(form, { isNew: true })).toEqual({ name: 'Q', code: 'NIS2_K', reference: null, description: null, attestation_valid_months: 12, status: 'active' });
        expect(toBody({ ...form, evergreen: true }, { isNew: false }).attestation_valid_months).toBeNull();
        expect(validate(form, { isNew: true })).toBeNull();
        expect(validate({ ...form, name: '  ' }, { isNew: true })).toBe('name');
        expect(validate({ ...form, code: 'x' }, { isNew: true })).toBe('code');
        expect(validate({ ...form, code: 'x' }, { isNew: false })).toBeNull();
        expect(validate({ ...form, months: '0' }, { isNew: true })).toBe('months');
        expect(CODE_RE.test('NIS2_KLANT')).toBe(true);
        expect(CODE_RE.test('nis2')).toBe(false);
        expect(editorErrorText(new Error('400 custom_framework_code_invalid'), (k, f) => f)).toContain('2–24');
        expect(editorErrorText(new Error('500 nope'), (k, f) => f)).toBe('The framework could not be saved.');
    });

    it('evidenceRef allow-lists the upload answer and attestErrorText maps the route codes', () => {
        expect(evidenceRef({ uploaded: true, sha256: 'abc', filename: 'x.pdf', secret: 'nope' }))
            .toEqual({ evidence_id: null, sha256: 'abc', filename: 'x.pdf' });
        expect(evidenceRef({ uploaded: true })).toBeNull();
        expect(evidenceRef(null)).toBeNull();
        const t = (k, f) => f;
        expect(attestErrorText(new Error('400 evidence_required'), t)).toContain('evidence');
        expect(attestErrorText('503 not_provisioned', t)).toContain('not installed');
        expect(attestErrorText(new Error('500 boom'), t)).toBe('The attestation could not be recorded.');
        expect(OUTCOMES.map(o => o.value)).toEqual(['compliant', 'partial', 'non_compliant', 'not_applicable']);
    });
});

describe('CustomFrameworksPage — phone (artboard 1h)', () => {
    it('the items table takes the card path, with the picker and the attest button as 44px targets', async () => {
        fetchJson
            .mockResolvedValueOnce(detailBody())
            .mockResolvedValueOnce(registryBody());
        render(<CustomFrameworksPage {...pageProps({ props: { isMobile: true } })} />);
        fireEvent.click(screen.getAllByTestId('custom-card')[0]);
        await waitFor(() => expect(screen.getAllByTestId('custom-checks-card').length).toBe(3));
        expect(screen.getByTestId('custom-checks').dataset.view).toBe('cards');
        expect(screen.queryAllByTestId('custom-checks-row').length).toBe(0);
        expect(screen.getAllByTestId('custom-checks-ref').map(el => el.textContent)).toEqual(['1', '2', '3']);
        expect(screen.getAllByTestId('custom-checks-status').map(el => el.textContent))
            .toEqual(['Satisfied', 'Attention', 'Not satisfied']);
        expect(screen.getAllByTestId('custom-checks-mapped')[0].className).toMatch(/min-h-\[44px\]/);
        expect(screen.getAllByTestId('custom-checks-attest')[0].className).toMatch(/min-h-\[44px\]/);
        expect(screen.getAllByTestId('custom-checks-attest')[2].disabled).toBe(true);
    });
});
