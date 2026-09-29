import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import TrainingPage, { attestationDueAt, OBLIGATION_KINDS } from './TrainingPage';

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

afterEach(cleanup);

const USERS = [{ id: 'u1', displayName: 'T. Smit', email: 't@example.com' }];

const PERSONNEL = [
    { user_id: 'u1', displayName: 'T. Smit', email: 'tom.smit@example.com', policy_acks: 3, policy_total: 3, learning_done: 4, attested_at: '2026-06-01T10:00:00Z', attested_note: 'Awareness 2026' },
    { user_id: 'u2', displayName: 'R. Bakker', email: 'rick@example.com', policy_acks: 1, policy_total: 3, learning_done: null, attested_at: null, attested_note: null },
];
const OBLIGATIONS = [
    { id: 11, kind: 'internal_audit', title: 'Internal audit 2026', subject: 'ISMS', due_at: '2026-12-01', recur_months: 12, owner_user_id: 'u1', completed_at: null },
    { id: 12, kind: 'pentest', title: 'External pentest', due_at: '2026-05-01', recur_months: null, owner_user_id: null, completed_at: '2026-04-20T09:00:00Z' },
];

function trainingState(over = {}) {
    return {
        personnel: PERSONNEL,
        obligations: OBLIGATIONS,
        busyId: null,
        refresh: vi.fn(),
        attest: vi.fn().mockResolvedValue({}),
        createObligation: vi.fn().mockResolvedValue({}),
        completeObligation: vi.fn().mockResolvedValue({}),
        ...over,
    };
}

function pageProps(over = {}) {
    const { training, ...rest } = over;
    return {
        section: { id: 'training' }, tab: null, onTab: vi.fn(), navigate: vi.fn(), focusId: null,
        exportsEnabled: true, dl: (u) => u, api: '/api/compliance', isMobile: false, setHeaderActions: vi.fn(),
        data: { training: trainingState(training), orgUsers: USERS },
        ...rest,
    };
}

describe('attestationDueAt', () => {
    it('is twelve months after the attestation', () => {
        expect(attestationDueAt({ attested_at: '2026-06-01T00:00:00Z' })).toContain('2027-06-01');
    });
    it('is null without an attestation — no clock, not a red one', () => {
        expect(attestationDueAt({ attested_at: null })).toBeNull();
        expect(attestationDueAt({})).toBeNull();
        expect(attestationDueAt({ attested_at: 'nonsense' })).toBeNull();
    });
});

describe('TrainingPage', () => {
    it('renders both registers', () => {
        render(<TrainingPage {...pageProps()} />);
        expect(screen.getByTestId('training-personnel-table')).toBeTruthy();
        expect(screen.getByTestId('training-obligations-table')).toBeTruthy();
    });

    it('masks personnel e-mail addresses (BFSF-441)', () => {
        render(<TrainingPage {...pageProps()} />);
        const cell = screen.getByTestId('training-email-u1').textContent;
        expect(cell).not.toBe('tom.smit@example.com');
        expect(cell).toContain('example.com');
        expect(document.body.textContent).not.toContain('tom.smit@example.com');
    });

    it('shows policy acknowledgements as n / m', () => {
        render(<TrainingPage {...pageProps()} />);
        expect(screen.getByTestId('training-acks-u1').textContent).toContain('3 / 3');
        expect(screen.getByTestId('training-acks-u2').textContent).toContain('1 / 3');
    });

    it('never invents an acknowledgement count either', () => {
        // `?? 0` printed "0 / 0" for a person the server said nothing about,
        // which reads as "acknowledged nothing" rather than "we do not know".
        render(<TrainingPage {...pageProps({ training: { personnel: [{ user_id: 'u9', displayName: 'S. Doe', email: 's@example.test' }] } })} />);
        expect(screen.queryByTestId('training-acks-u9')).toBeNull();
        expect(screen.getByTestId('training-person-u9').textContent).not.toMatch(/0\s*\/\s*0/);
    });

    it('never invents a learning count', () => {
        render(<TrainingPage {...pageProps()} />);
        expect(screen.getByTestId('training-learning-u1').textContent).toBe('4');
        expect(screen.queryByTestId('training-learning-u2')).toBeNull();
    });

    it('draws a clock for an attested member and says "never" for the rest', () => {
        render(<TrainingPage {...pageProps()} />);
        expect(screen.getByTestId('training-clock-u1')).toBeTruthy();
        expect(screen.queryByTestId('training-clock-u2')).toBeNull();
        expect(screen.getByTestId('training-never-u2')).toBeTruthy();
    });

    it('records a training attestation with its note', async () => {
        const attest = vi.fn().mockResolvedValue({});
        render(<TrainingPage {...pageProps({ training: { attest } })} />);
        fireEvent.click(screen.getByTestId('training-attest-u2'));
        fireEvent.change(screen.getByTestId('attest-note'), { target: { value: 'Awareness course 3 Sep' } });
        fireEvent.click(screen.getByTestId('attest-submit'));
        await waitFor(() => expect(attest).toHaveBeenCalledWith('u2', 'Awareness course 3 Sep'));
    });

    it('sends no note when the field is left empty', async () => {
        const attest = vi.fn().mockResolvedValue({});
        render(<TrainingPage {...pageProps({ training: { attest } })} />);
        fireEvent.click(screen.getByTestId('training-attest-u2'));
        fireEvent.click(screen.getByTestId('attest-submit'));
        await waitFor(() => expect(attest).toHaveBeenCalledWith('u2', undefined));
    });

    it('shows the previous attestation when recording again', () => {
        render(<TrainingPage {...pageProps()} />);
        fireEvent.click(screen.getByTestId('training-attest-u1'));
        expect(screen.getByTestId('attest-previous').textContent).toContain('Awareness 2026');
    });

    it('completes an open obligation and shows the stamp on a done one', () => {
        const completeObligation = vi.fn();
        render(<TrainingPage {...pageProps({ training: { completeObligation } })} />);
        fireEvent.click(screen.getByTestId('obligation-complete-11'));
        expect(completeObligation).toHaveBeenCalledWith(11);
        expect(screen.queryByTestId('obligation-complete-12')).toBeNull();
        expect(screen.getByTestId('obligation-done-12')).toBeTruthy();
    });

    it('creates an obligation from the drawer', async () => {
        const createObligation = vi.fn().mockResolvedValue({});
        render(<TrainingPage {...pageProps({ training: { createObligation } })} />);
        fireEvent.click(screen.getByTestId('obligation-add'));
        fireEvent.change(screen.getByTestId('obligation-f-title'), { target: { value: 'Supplier review' } });
        fireEvent.change(screen.getByTestId('obligation-f-kind'), { target: { value: 'supplier_review' } });
        fireEvent.change(screen.getByTestId('obligation-f-due'), { target: { value: '2027-01-15' } });
        fireEvent.change(screen.getByTestId('obligation-f-recur'), { target: { value: '6' } });
        fireEvent.click(screen.getByTestId('obligation-create-submit'));
        await waitFor(() => expect(createObligation).toHaveBeenCalled());
        expect(createObligation).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'supplier_review', title: 'Supplier review', due_at: '2027-01-15', recur_months: 6,
        }));
    });

    it('refuses to create an obligation without a title or a due date', () => {
        const createObligation = vi.fn();
        render(<TrainingPage {...pageProps({ training: { createObligation } })} />);
        fireEvent.click(screen.getByTestId('obligation-add'));
        fireEvent.click(screen.getByTestId('obligation-create-submit'));
        expect(createObligation).not.toHaveBeenCalled();
    });

    it('a failed read of either list is its own state', () => {
        render(<TrainingPage {...pageProps({ training: { personnel: { error: 'x' }, obligations: { error: 'x' } } })} />);
        expect(screen.getByTestId('training-personnel-failed')).toBeTruthy();
        expect(screen.getByTestId('training-obligations-failed')).toBeTruthy();
        expect(screen.queryByTestId('training-personnel-table')).toBeNull();
    });

    it('shows skeletons while the lists are still being read', () => {
        render(<TrainingPage {...pageProps({ training: { personnel: null, obligations: null } })} />);
        expect(screen.getAllByTestId('table-skeleton-row').length).toBeGreaterThan(0);
    });

    it('knows every obligation kind the legacy page offered', () => {
        expect(Object.keys(OBLIGATION_KINDS)).toEqual([
            'policy_review', 'soa_review', 'internal_audit', 'management_review',
            'training', 'access_review', 'supplier_review', 'pentest', 'custom',
        ]);
    });
});

describe('TrainingPage — phone (artboard 1h)', () => {
    it('both registers take the card path, with the same data as their rows', () => {
        render(<TrainingPage {...pageProps({ isMobile: true })} />);
        expect(screen.getByTestId('training-personnel-table').dataset.view).toBe('cards');
        expect(screen.getByTestId('training-obligations-table').dataset.view).toBe('cards');
        const person = screen.getByTestId('training-person-card-u1');
        expect(person.textContent).toMatch(/T\. Smit/);
        expect(person.textContent).toMatch(/3 \/ 3/);
        expect(person.textContent).toMatch(/•••@example\.com/); // the e-mail is masked, as in the row
        expect(person.textContent).not.toMatch(/tom\.smit@/);
        expect(screen.getByTestId('obligation-card-11').textContent).toMatch(/Internal audit 2026/);
        expect(screen.queryByTestId('training-person-u1')).toBeNull();
    });

    it('a person without stated acknowledgement counts shows no pill — never "0 / 0"', () => {
        const training = { personnel: [{ user_id: 'u9', displayName: 'N. Unknown', email: 'n@example.com' }], obligations: [] };
        render(<TrainingPage {...pageProps({ isMobile: true, training })} />);
        expect(screen.queryByTestId('training-acks-card-u9')).toBeNull();
        expect(screen.getByTestId('training-person-card-u9').textContent).not.toMatch(/0 \/ 0/);
    });

    it('the attest drawer is a right-side modal on a phone', () => {
        render(<TrainingPage {...pageProps({ isMobile: true })} />);
        fireEvent.click(screen.getByTestId('training-attest-card-u1'));
        expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
        expect(screen.getByTestId('attest-drawer').dataset.mode).toBe('modal');
    });

    it('desktop keeps the grid rows and the inline drawer', () => {
        render(<TrainingPage {...pageProps()} />);
        expect(screen.getByTestId('training-personnel-table').dataset.view).toBe('table');
        fireEvent.click(screen.getByTestId('training-attest-u1'));
        expect(document.body.querySelector('[role="dialog"]')).toBeNull();
        expect(screen.getByTestId('attest-drawer').dataset.mode).toBe('inline');
    });
});
