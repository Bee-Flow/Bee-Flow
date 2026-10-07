import { render, screen, cleanup, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import TrainingPage, { OBLIGATION_KINDS } from './TrainingPage';
import { attestationDueAt, needsAttestation } from './trainingAttestation';

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

const DAY_MS = 86_400_000;
const daysAgo = (n) => new Date(Date.now() - n * DAY_MS).toISOString();

// u1 attested 100 days ago (265 days left: no button, a quiet clock), u2
// never (a button), u3 320 days ago (about 45 days left: a button).
const PERSONNEL = [
    { user_id: 'u1', displayName: 'T. Smit', email: 'tom.smit@example.com', policy_acks: 3, policy_total: 3, learning_done: 4, attested_at: daysAgo(100), attested_note: 'Awareness 2026' },
    { user_id: 'u2', displayName: 'R. Bakker', email: 'rick@example.com', policy_acks: 1, policy_total: 3, learning_done: null, attested_at: null, attested_note: null },
    { user_id: 'u3', displayName: 'F. Amrani', email: 'farah@example.com', policy_acks: 3, policy_total: 3, learning_done: 1, attested_at: daysAgo(320), attested_note: null },
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

/** The create action the page handed to the header, as the header would click it. */
function clickHeaderPrimary(setHeaderActions) {
    const calls = setHeaderActions.mock.calls.filter(([a]) => a && a.primaryAction);
    const { primaryAction } = calls[calls.length - 1][0];
    act(() => primaryAction.onClick());
    return primaryAction;
}

describe('needsAttestation', () => {
    it('without an attestation, or with 60 days or less left on it', () => {
        expect(needsAttestation({ attested_at: null })).toBe(true);
        expect(needsAttestation({ attested_at: daysAgo(320) })).toBe(true);
        expect(needsAttestation({ attested_at: daysAgo(100) })).toBe(false);
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

    it('only the members who need action carry the inline button', () => {
        render(<TrainingPage {...pageProps()} />);
        expect(screen.queryByTestId('training-attest-u1')).toBeNull();
        expect(screen.getByTestId('training-attest-u2').textContent).toContain('Attest training');
        expect(screen.getByTestId('training-attest-u3').textContent).toContain('Re-attest');
    });

    it('a distant validity date is a quiet clock, with the full date in its tooltip', () => {
        render(<TrainingPage {...pageProps()} />);
        const clock = screen.getByTestId('training-clock-u1');
        expect(clock.hasAttribute('data-quiet')).toBe(true);
        expect(clock.getAttribute('data-tone')).toBe('neutral');
        expect(clock.parentElement.getAttribute('title')).toMatch(/\d{1,2} \w{3}/);
        // The button shows from 60 days out, the clock stays quiet until 30.
        expect(screen.getByTestId('training-clock-u3').hasAttribute('data-quiet')).toBe(true);
    });

    it('a clock with 30 days or less left is no longer quiet', () => {
        const personnel = [{ user_id: 'u4', displayName: 'J. Visser', email: 'j@example.com', attested_at: daysAgo(350) }];
        render(<TrainingPage {...pageProps({ training: { personnel } })} />);
        expect(screen.getByTestId('training-clock-u4').hasAttribute('data-quiet')).toBe(false);
        expect(screen.getByTestId('training-attest-u4')).toBeTruthy();
    });

    it('the column reads "Training valid"', () => {
        render(<TrainingPage {...pageProps()} />);
        const header = within(screen.getByTestId('training-personnel-table')).getAllByRole('columnheader').map(h => h.textContent);
        expect(header).toContain('Training valid');
    });

    it('a row click opens the attest drawer, also for a member without a button', async () => {
        const user = userEvent.setup();
        render(<TrainingPage {...pageProps()} />);
        await user.click(screen.getByTestId('training-person-u1'));
        expect(screen.getByTestId('attest-drawer')).toBeTruthy();
        expect(screen.getByTestId('attest-previous').textContent).toContain('Awareness 2026');
    });

    it('records a training attestation with its note', async () => {
        const user = userEvent.setup();
        const attest = vi.fn().mockResolvedValue({});
        render(<TrainingPage {...pageProps({ training: { attest } })} />);
        await user.click(screen.getByTestId('training-attest-u2'));
        await user.type(screen.getByTestId('attest-note'), 'Awareness course 3 Sep');
        await user.click(screen.getByTestId('attest-submit'));
        await waitFor(() => expect(attest).toHaveBeenCalledWith('u2', 'Awareness course 3 Sep'));
    });

    it('sends no note when the field is left empty', async () => {
        const user = userEvent.setup();
        const attest = vi.fn().mockResolvedValue({});
        render(<TrainingPage {...pageProps({ training: { attest } })} />);
        await user.click(screen.getByTestId('training-attest-u2'));
        await user.click(screen.getByTestId('attest-submit'));
        await waitFor(() => expect(attest).toHaveBeenCalledWith('u2', undefined));
    });

    it('completes an open obligation; a done one reads "Done {date}" once and has no action', async () => {
        const user = userEvent.setup();
        const completeObligation = vi.fn();
        render(<TrainingPage {...pageProps({ training: { completeObligation } })} />);
        await user.click(screen.getByTestId('obligation-complete-11'));
        expect(completeObligation).toHaveBeenCalledWith(11);
        expect(screen.queryByTestId('obligation-complete-12')).toBeNull();
        const row = screen.getByTestId('obligation-row-12');
        expect(screen.getByTestId('obligation-done-12').textContent).toMatch(/^Done 20 Apr/);
        expect(row.textContent.match(/Done /g)).toHaveLength(1);
        expect(within(row).queryByRole('button')).toBeNull();
    });

    it('the kind is plain secondary text, not a bordered pill', () => {
        render(<TrainingPage {...pageProps()} />);
        const kind = screen.getByTestId('obligation-kind-11');
        expect(kind.textContent).toBe('Internal audit');
        expect(kind.closest('[data-testid="status-pill"]')).toBeNull();
        expect(kind.className).not.toMatch(/border/);
    });

    it('"Add obligation" sits in the header and opens the create drawer', async () => {
        const user = userEvent.setup();
        const setHeaderActions = vi.fn();
        const createObligation = vi.fn().mockResolvedValue({});
        render(<TrainingPage {...pageProps({ setHeaderActions, training: { createObligation } })} />);
        expect(screen.queryByTestId('obligation-add')).toBeNull();
        expect(clickHeaderPrimary(setHeaderActions).label).toBe('Add obligation');
        await user.type(screen.getByTestId('obligation-f-title'), 'Supplier review');
        await user.selectOptions(screen.getByTestId('obligation-f-kind'), 'supplier_review');
        await user.type(screen.getByTestId('obligation-f-due'), '2027-01-15');
        await user.type(screen.getByTestId('obligation-f-recur'), '6');
        await user.click(screen.getByTestId('obligation-create-submit'));
        await waitFor(() => expect(createObligation).toHaveBeenCalled());
        expect(createObligation).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'supplier_review', title: 'Supplier review', due_at: '2027-01-15', recur_months: 6,
        }));
    });

    it('a host without a header keeps "Add obligation" in the toolbar', async () => {
        const user = userEvent.setup();
        render(<TrainingPage {...pageProps({ setHeaderActions: undefined })} />);
        await user.click(screen.getByTestId('obligation-add'));
        expect(screen.getByTestId('obligation-drawer')).toBeTruthy();
    });

    it('refuses to create an obligation without a title or a due date', async () => {
        const user = userEvent.setup();
        const createObligation = vi.fn();
        render(<TrainingPage {...pageProps({ setHeaderActions: undefined, training: { createObligation } })} />);
        await user.click(screen.getByTestId('obligation-add'));
        await user.click(screen.getByTestId('obligation-create-submit'));
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

    it('an obligation card puts dots only between the parts it has', () => {
        render(<TrainingPage {...pageProps({ isMobile: true })} />);
        // obl 12: a kind and nothing else, so no trailing dot.
        const bare = screen.getByTestId('obligation-kind-card-12').parentElement;
        expect(bare.textContent).toBe('Penetration test');
        // obl 11: kind · subject · every 12 months · owner.
        const full = screen.getByTestId('obligation-kind-card-11').parentElement.textContent;
        expect(full).toMatch(/^Internal audit · ISMS · every 12 months · /);
        expect(full).not.toMatch(/·\s*·|·\s*$/);
    });

    it('a card carries the button only when the member needs action', () => {
        render(<TrainingPage {...pageProps({ isMobile: true })} />);
        expect(screen.queryByTestId('training-attest-card-u1')).toBeNull();
        expect(screen.getByTestId('training-attest-card-u2')).toBeTruthy();
    });

    it('the attest drawer is a right-side modal on a phone', async () => {
        const user = userEvent.setup();
        render(<TrainingPage {...pageProps({ isMobile: true })} />);
        await user.click(screen.getByTestId('training-person-open-card-u1'));
        expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
        expect(screen.getByTestId('attest-drawer').dataset.mode).toBe('modal');
    });

    it('desktop keeps the grid rows and the inline drawer', async () => {
        const user = userEvent.setup();
        render(<TrainingPage {...pageProps()} />);
        expect(screen.getByTestId('training-personnel-table').dataset.view).toBe('table');
        await user.click(screen.getByTestId('training-attest-u2'));
        expect(document.body.querySelector('[role="dialog"]')).toBeNull();
        expect(screen.getByTestId('attest-drawer').dataset.mode).toBe('inline');
    });
});
