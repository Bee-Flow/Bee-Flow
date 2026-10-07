import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import MachineryPage, { subjectRows, assessmentPill, signalText, CLASSIFICATIONS, ART18_CHECK_ID } from './MachineryPage';

vi.mock('../../../../hooks/useTranslation', () => {
    const useTranslation = () => ({
        t: (key, fallback, params) => {
            let out = typeof fallback === 'string' ? fallback : key;
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

function detections() {
    return {
        scanned: { integrations: 4, automations: 12 },
        skipped: [],
        classifications: ['safety_component', 'monitoring_only', 'not_safety_component'],
        matches: [
            {
                source: 'custom_integration', id: 'int-1', label: 'Siemens line 3',
                signals: [{ kind: 'scheme', value: 'opc.tcp://' }, { kind: 'port', value: '4840' }],
                confidence: 'high', subject_id: 'custom_integration:int-1',
                assessment: null,
            },
            {
                source: 'automation', id: 'a-9', label: 'Nightly MES sync',
                signals: [{ kind: 'keyword', value: 'modbus' }],
                confidence: 'low', subject_id: 'automation:a-9',
                assessment: { id: 'att-1', classification: 'not_safety_component', attested_at: '2026-01-10T00:00:00Z', expires_at: '2027-01-10T00:00:00Z', current: true },
            },
            {
                source: 'mcp_server', id: 'm-2', label: 'PLC bridge',
                signals: [], confidence: 'high', subject_id: 'mcp_server:m-2',
                assessment: { id: 'att-2', classification: 'safety_component', attested_at: '2025-02-01T00:00:00Z', expires_at: '2026-02-01T00:00:00Z', current: false },
            },
        ],
        manual_subjects: [
            { subject_id: 'manual:press-7', label: 'Press 7 (added by hand)', source: 'manual', assessment: null },
        ],
    };
}

const props = (over = {}) => ({
    isMobile: false,
    setHeaderActions: vi.fn(),
    data: { bump: vi.fn(), core: { refresh: vi.fn(() => Promise.resolve()) } },
    ...over,
});

describe('MachineryPage — detections table', () => {
    it('lists detections and the hand-added subjects, manual last', async () => {
        fetchJson.mockResolvedValueOnce(detections());
        render(<MachineryPage {...props()} />);
        await waitFor(() => expect(screen.getAllByTestId('mach-row').length).toBe(4));
        expect(fetchJson.mock.calls[0][0]).toMatch(/\/machinery\/detections$/);
        expect([...screen.getAllByTestId('mach-label')].map(el => el.dataset.subject)).toEqual([
            'custom_integration:int-1', 'automation:a-9', 'mcp_server:m-2', 'manual:press-7',
        ]);
        expect(screen.getAllByTestId('mach-confidence').map(el => el.dataset.confidence))
            .toEqual(['high', 'low', 'high', 'manual']);
        expect(screen.getAllByTestId('mach-signals')[0].textContent).toBe('scheme opc.tcp:// · port 4840');
    });

    it('the declaration pill follows the classification, and an expired one warns', async () => {
        fetchJson.mockResolvedValueOnce(detections());
        render(<MachineryPage {...props()} />);
        await waitFor(() => expect(screen.getAllByTestId('mach-assessment').length).toBe(4));
        const pills = screen.getAllByTestId('mach-assessment');
        expect(pills[0].textContent).toBe('Not assessed');
        expect(pills[0].dataset.tone).toBe('neutral');
        expect(pills[1].textContent).toBe('Not a safety component');
        expect(pills[1].dataset.tone).toBe('success');
        expect(pills[2].textContent).toContain('expired');
        expect(pills[2].dataset.tone).toBe('warning');
        expect(screen.getAllByTestId('mach-attest')[0].textContent).toContain('Declare');
        expect(screen.getAllByTestId('mach-attest')[1].textContent).toContain('Re-declare');
    });

    it('a 503 says the detector was never installed — that is not "nothing found"', async () => {
        fetchJson.mockRejectedValueOnce(new Error('503 Service Unavailable'));
        render(<MachineryPage {...props()} />);
        await waitFor(() => expect(screen.getByTestId('machinery-page-unavailable')).toBeTruthy());
        expect(screen.queryByTestId('mach-table')).toBeNull();
        expect(screen.getByTestId('machinery-page-unavailable').textContent).toContain('not installed');
    });

    it('any other failed read is its own state, distinct from the missing detector', async () => {
        fetchJson.mockRejectedValueOnce(new Error('500 Internal Server Error'));
        render(<MachineryPage {...props()} />);
        await waitFor(() => expect(screen.getByTestId('machinery-page-failed')).toBeTruthy());
        expect(screen.queryByTestId('machinery-page-unavailable')).toBeNull();
    });

    it('an empty but successful scan is an empty state, not a failure', async () => {
        fetchJson.mockResolvedValueOnce({ scanned: {}, matches: [], manual_subjects: [], skipped: [] });
        render(<MachineryPage {...props()} />);
        await waitFor(() => expect(screen.getByText('No machine integrations found')).toBeTruthy());
        expect(screen.queryByTestId('machinery-page-unavailable')).toBeNull();
    });
});

describe('MachineryPage — attest drawer', () => {
    it('opens on a row, loads the history, and posts the classification to the machinery route', async () => {
        fetchJson
            .mockResolvedValueOnce(detections())                                   // detections
            .mockResolvedValueOnce([{ id: 'h1', classification: 'monitoring_only', attested_at: '2025-05-05T00:00:00Z' }]) // history
            .mockResolvedValueOnce({ id: 'new', classification: 'safety_component' })  // attest
            .mockResolvedValueOnce(detections());                                  // refresh
        const p = props();
        render(<MachineryPage {...p} />);
        await waitFor(() => expect(screen.getAllByTestId('mach-row').length).toBe(4));

        fireEvent.click(screen.getAllByTestId('mach-attest')[0]);
        await waitFor(() => expect(screen.getByTestId('mach-drawer-title')).toBeTruthy());
        expect(screen.getByTestId('mach-drawer-title').textContent).toBe('Siemens line 3');
        expect(screen.getByTestId('mach-drawer-ref').textContent).toBe('custom_integration:int-1');
        await waitFor(() => expect(screen.getByTestId('mach-drawer-history-row')).toBeTruthy());
        expect(fetchJson.mock.calls[1][0]).toMatch(/\/machinery\/subjects\/custom_integration%3Aint-1\/attestations$/);
        expect(screen.getByTestId('mach-drawer-history-row').textContent).toContain('Monitoring only');

        // The record button stays closed until a classification is picked.
        expect(screen.getByTestId('mach-drawer-submit').disabled).toBe(true);
        const options = screen.getAllByTestId('mach-drawer-option');
        expect(options.map(o => o.dataset.value)).toEqual(['safety_component', 'monitoring_only', 'not_safety_component']);
        fireEvent.click(options[0]);
        expect(options[0].getAttribute('aria-checked')).toBe('true');
        fireEvent.change(screen.getByTestId('mach-drawer-statement'), { target: { value: 'Stops the press on a light-curtain break.' } });
        expect(screen.getByTestId('mach-drawer-submit').disabled).toBe(false);

        fireEvent.click(screen.getByTestId('mach-drawer-submit'));
        await waitFor(() => expect(fetchJson.mock.calls.length).toBeGreaterThanOrEqual(4));
        const [url, init] = fetchJson.mock.calls[2];
        expect(url).toMatch(/\/machinery\/subjects\/custom_integration%3Aint-1\/attest$/);
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({
            classification: 'safety_component',
            statement: 'Stops the press on a light-curtain break.',
            evidence_refs: [],
        });
        await waitFor(() => expect(p.data.bump).toHaveBeenCalled());
        expect(p.data.core.refresh).toHaveBeenCalled();
        await waitFor(() => expect(screen.queryByTestId('mach-drawer-title')).toBeNull());
    });

    it('a deep link (focusId) opens the drawer AND loads its history — "Earlier attestations" never hangs on loading', async () => {
        fetchJson.mockImplementation((url) => Promise.resolve(/\/attestations$/.test(url)
            ? [{ id: 'h1', classification: 'not_safety_component', attested_at: '2026-01-10T00:00:00Z' }]
            : detections()));
        render(<MachineryPage {...props({ focusId: 'automation:a-9' })} />);
        await waitFor(() => expect(screen.getByTestId('mach-drawer-title').textContent).toBe('Nightly MES sync'));
        await waitFor(() => expect(screen.getByTestId('mach-drawer-history-row')).toBeTruthy());
        expect(fetchJson.mock.calls.map(c => c[0]).some(u => /\/machinery\/subjects\/automation%3Aa-9\/attestations$/.test(u))).toBe(true);
    });

    it('the Signals and Valid columns fold below 900px, not 1180px', async () => {
        fetchJson.mockResolvedValueOnce(detections());
        render(<MachineryPage {...props()} />);
        await waitFor(() => expect(screen.getAllByTestId('mach-row').length).toBe(4));
        const header = (name) => screen.getAllByRole('columnheader').find(h => h.textContent === name);
        for (const name of ['Signals', 'Valid']) {
            expect(header(name).className).toContain('900px');
            expect(header(name).className).not.toContain('1180px');
        }
    });

    it('the drawer opens pre-set on the existing classification and a failed history is its own state', async () => {
        fetchJson
            .mockResolvedValueOnce(detections())
            .mockRejectedValueOnce(new Error('500 boom'));
        render(<MachineryPage {...props()} />);
        await waitFor(() => expect(screen.getAllByTestId('mach-row').length).toBe(4));
        fireEvent.click(screen.getAllByTestId('mach-attest')[1]);
        await waitFor(() => expect(screen.getByTestId('mach-drawer-history-failed')).toBeTruthy());
        const active = screen.getAllByTestId('mach-drawer-option').find(o => o.dataset.active === 'true');
        expect(active.dataset.value).toBe('not_safety_component');
    });

    it('a refused attestation shows the route\'s reason and keeps the drawer open', async () => {
        fetchJson
            .mockResolvedValueOnce(detections())
            .mockResolvedValueOnce([])
            .mockRejectedValueOnce(new Error('400 invalid_subject'));
        render(<MachineryPage {...props()} />);
        await waitFor(() => expect(screen.getAllByTestId('mach-row').length).toBe(4));
        fireEvent.click(screen.getAllByTestId('mach-attest')[0]);
        await waitFor(() => expect(screen.getByTestId('mach-drawer-history-empty')).toBeTruthy());
        fireEvent.click(screen.getAllByTestId('mach-drawer-option')[1]);
        fireEvent.click(screen.getByTestId('mach-drawer-submit'));
        await waitFor(() => expect(screen.getByTestId('mach-drawer-error')).toBeTruthy());
        expect(screen.getByTestId('mach-drawer-error').textContent).toContain('cannot be attested');
        expect(screen.getByTestId('mach-drawer-title')).toBeTruthy();
    });
});

describe('pure helpers', () => {
    it('subjectRows folds matches + manual subjects, and reads null as not-loaded', () => {
        expect(subjectRows(null)).toBeNull();
        expect(subjectRows([])).toBeNull();
        const rows = subjectRows(detections());
        expect(rows.length).toBe(4);
        expect(rows[3]).toMatchObject({ subject_id: 'manual:press-7', source: 'manual', confidence: 'manual', signals: [] });
        expect(subjectRows({ matches: [{ source: 's', id: 'i' }] })[0].subject_id).toBe('s:i');
    });

    it('assessmentPill maps classification → tone and marks an expired one', () => {
        expect(assessmentPill(null)).toMatchObject({ tone: 'neutral', key: 'compliance.mach_not_assessed' });
        expect(assessmentPill({ classification: 'safety_component', current: true }).tone).toBe('error');
        expect(assessmentPill({ classification: 'monitoring_only', current: true }).tone).toBe('warning');
        expect(assessmentPill({ classification: 'not_safety_component', current: true }).tone).toBe('success');
        expect(assessmentPill({ classification: 'safety_component', current: false })).toMatchObject({ tone: 'warning', expired: true });
    });

    it('signalText joins at most four signals and the vocabulary matches the routes', () => {
        const t = (key, fallback) => fallback;
        expect(signalText([], t)).toBeNull();
        expect(signalText(null, t)).toBeNull();
        expect(signalText([{ kind: 'port', value: '502' }], t)).toBe('port 502');
        expect(signalText(Array.from({ length: 6 }, (_, i) => ({ kind: 'keyword', value: `k${i}` })), t).split(' · ').length).toBe(4);
        expect(CLASSIFICATIONS.map(c => c.value)).toEqual(['safety_component', 'monitoring_only', 'not_safety_component']);
        expect(ART18_CHECK_ID).toBe('MACHINERY-Art18-safety-component-assessment');
    });
});

describe('MachineryPage — phone (artboard 1h)', () => {
    it('takes the card path with the row data and a 44px declare button', async () => {
        fetchJson.mockResolvedValueOnce(detections());
        render(<MachineryPage {...props({ isMobile: true })} />);
        await waitFor(() => expect(screen.getAllByTestId('mach-card').length).toBe(4));
        expect(screen.getByTestId('mach-table').dataset.view).toBe('cards');
        expect(screen.queryAllByTestId('mach-row').length).toBe(0);
        const first = screen.getAllByTestId('mach-card')[0];
        expect(first.textContent).toMatch(/Siemens line 3/);
        expect(first.textContent).toMatch(/opc\.tcp/);
        expect(screen.getAllByTestId('mach-attest')[0].className).toMatch(/min-h-\[44px\]/);
    });
});
