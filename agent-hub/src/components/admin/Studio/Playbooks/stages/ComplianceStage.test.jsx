import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { act, cleanup as _c, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ComplianceStage from './ComplianceStage';
import { playbooksApi } from '../playbooksApi';

vi.mock('../playbooksApi', () => {
    const playbooksApi = {
        register: vi.fn(),
        retentionPreview: vi.fn(async () => ({ usable: true, oldest: '2025-07-01', oldestDays: 412, newest: '2026-09-01', rowCount: 32, outsideWindow: 3, retentionDays: 365, retentionField: 'invoice_date', retentionFieldName: 'Invoice Date' })),
        resolvePlan: vi.fn(),
        runPhase: vi.fn(),
    };
    return { playbooksApi, default: playbooksApi };
});
vi.mock('../../../../../hooks/useAutomationApi', () => ({ default: () => ({ updateAutomation: vi.fn(async () => ({})) }) }));

const PB = { id: 'pb_1', title: 'Invoice Insights' };

const t = (k, f, v) => (v ? Object.entries(v).reduce((s, [a, b]) => s.replace(`{${a}}`, String(b)), f) : f);
const FINDINGS = [
    { code: 'personal_data_org_wide', severity: 'high', framework: 'GDPR', article: 'Art. 5(1)(c), 32', subject: 'App "Invoices"', title: 'Personal data is open to the whole organisation', why: 'The table holds E-mail.', fix: 'Share it with the groups that need it.', source: 'rule' },
    { code: 'ai_1', severity: 'low', framework: 'ISO27001', article: 'A.5.15', subject: 'App "Invoices"', title: 'Nobody holds a named role', why: 'Everyone falls back to the default.', fix: 'Name an administrator.', source: 'ai' },
];

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe('ComplianceStage — the closing reading', () => {
    it('starts a ready phase once and says what it is reading', () => {
        const dispatch = vi.fn();
        const phase = { key: 'compliance', kind: 'compliance', status: 'ready', attempt: 0, artifacts: {} };
        const { rerender } = render(<ComplianceStage playbook={PB} phase={phase} dispatch={dispatch} t={t} />);
        expect(dispatch).toHaveBeenCalledWith({ type: 'start', key: 'compliance' });
        rerender(<ComplianceStage playbook={PB} phase={phase} dispatch={dispatch} t={t} />);
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(screen.getByText(/Reading the table, the automations and the app/)).toBeTruthy();
    });

    it('shows each finding with its framework, where it came from and what to do', () => {
        render(<ComplianceStage playbook={PB} phase={{ key: 'compliance', status: 'awaiting', attempt: 0, artifacts: { findings: FINDINGS, frameworks: ['GDPR', 'ISO27001'] } }} dispatch={vi.fn()} t={t} />);
        expect(screen.getByText('Against: GDPR, ISO27001')).toBeTruthy();
        // A `low` finding is a NOTE: it folds away, so three orange rows do
        // not read as three broken things.
        let items = screen.getAllByTestId('playbook-compliance-finding');
        expect(items).toHaveLength(1);
        expect(items[0].getAttribute('data-severity')).toBe('high');
        expect(items[0].textContent).toContain('GDPR Art. 5(1)(c), 32');
        expect(items[0].textContent).toContain('from the facts');
        expect(items[0].textContent).toContain('Share it with the groups that need it.');
        expect(items[0].textContent).toContain('Fix before you share');
        fireEvent.click(screen.getByTestId('playbook-compliance-notes-toggle'));
        items = screen.getAllByTestId('playbook-compliance-finding');
        expect(items).toHaveLength(2);
        expect(items[1].textContent).toContain('noticed by the AI');
        expect(items[1].textContent).toContain('Good to know');
        // It says plainly that it changed nothing.
        expect(screen.getByText(/the review itself changed nothing/)).toBeTruthy();
    });

    it('a clean reading says so; a model that could not be reached says that too', () => {
        render(<ComplianceStage playbook={PB} phase={{ key: 'compliance', status: 'awaiting', attempt: 0, artifacts: { findings: [], frameworks: ['GDPR'], modelFailed: 'down' } }} dispatch={vi.fn()} t={t} />);
        expect(screen.getByTestId('playbook-compliance-clean')).toBeTruthy();
        expect(screen.getByTestId('playbook-compliance-model-note')).toBeTruthy();
    });

    it('no framework switched on is said out loud, not shown as a pass', () => {
        render(<ComplianceStage playbook={PB} phase={{ key: 'compliance', status: 'awaiting', attempt: 0, artifacts: { findings: [], frameworks: [] } }} dispatch={vi.fn()} t={t} />);
        expect(screen.getByText(/No framework is switched on in the Compliance Center/)).toBeTruthy();
    });

    it('registers what the person confirmed, and then points at the register', async () => {
        const FACTS = {
            table: { id: 'tbl_1', name: 'Invoices', columns: [{ key: 'supplier', name: 'Leverancier' }, { key: 'email', name: 'E-mail' }, { key: 'invoice_date', name: 'Invoice Date', type: 'date' }], personal: [{ key: 'email', name: 'E-mail', kind: 'email', kinds: ['email'] }], lawfulBasis: null, retentionDays: null, retentionField: null, subjectColumn: null },
            org: { legalBases: ['contract', 'legitimate interest'], defaultRetentionDays: 365 },
            app: { id: 'app_1', name: 'Invoices' },
        };
        const phase = { key: 'compliance', status: 'awaiting', attempt: 0, artifacts: { findings: FINDINGS, frameworks: ['GDPR'], facts: FACTS } };
        const onNavigate = vi.fn();
        const dispatch = vi.fn();
        playbooksApi.register.mockResolvedValue({
            written: ['processing_register', 'risks:1', 'evidence'], failed: [],
            playbook: { id: 'pb_1', phases: [{ ...phase, artifacts: { ...phase.artifacts, registered: { written: ['processing_register', 'risks:1', 'evidence'] } } }] },
        });
        render(<ComplianceStage playbook={PB} phase={phase} dispatch={dispatch} t={t} onNavigate={onNavigate} />);

        // Prefilled from the organisation's own settings — except the legal
        // basis, which opens EMPTY and says so. Filling it from
        // `org.legalBases[0]` put a legal position on the record one click
        // away that nobody had taken.
        expect(screen.getByTestId('playbook-compliance-basis').value).toBe('');
        expect(screen.getByTestId('playbook-compliance-basis-open')).toBeTruthy();
        expect(screen.getByTestId('playbook-compliance-retention').value).toBe('365');

        // The person changes what they want, CHOOSES THE BASIS themselves —
        // the one thing on this form that is theirs to decide — and unticks
        // one finding.
        fireEvent.change(screen.getByTestId('playbook-compliance-basis'), { target: { value: 'consent' } });
        expect(screen.queryByTestId('playbook-compliance-basis-open')).toBeNull();
        fireEvent.change(screen.getByTestId('playbook-compliance-subject'), { target: { value: 'supplier' } });
        fireEvent.click(screen.getByTestId('playbook-compliance-notes-toggle'));
        const boxes = screen.getAllByTestId('playbook-compliance-keep');
        expect(boxes).toHaveLength(2);
        fireEvent.click(boxes[1]);   // drop the second from the risk register

        await act(async () => { fireEvent.click(screen.getByTestId('playbook-compliance-register-go')); });
        await waitFor(() => expect(playbooksApi.register).toHaveBeenCalledWith('pb_1', 'compliance', {
            registration: { lawfulBasis: 'consent', retentionDays: 365, retentionField: 'created_at', subjectColumn: 'supplier' },
            risks: ['personal_data_org_wide'],
        }));
        // The server's answer replaces the entity — no second write, no refetch.
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'replace' }));
    });

    it('once registered it says so and offers the way in', () => {
        const phase = { key: 'compliance', status: 'awaiting', attempt: 0, artifacts: { findings: FINDINGS, frameworks: ['GDPR'], facts: { table: { id: 'tbl_1', name: 'Invoices', columns: [] } }, registered: { written: ['processing_register', 'evidence'] } } };
        const onNavigate = vi.fn();
        render(<ComplianceStage playbook={PB} phase={phase} dispatch={vi.fn()} t={t} onNavigate={onNavigate} />);
        expect(screen.queryByTestId('playbook-compliance-register')).toBeNull();
        // Sentences, not the server's own words for its writes.
        const done = screen.getByTestId('playbook-compliance-registered').textContent;
        expect(done).toContain('the table is in the processing register');
        expect(done).toContain('this review is on the evidence chain');
        expect(done).not.toContain('processing_register');
        // And it lands on THAT entry, not just the register page.
        fireEvent.click(screen.getByTestId('playbook-compliance-open-ropa'));
        expect(onNavigate).toHaveBeenCalledWith('settings/organisation/compliance/ropa/datatable%3Atbl_1');
    });

    it('a finding points at the thing it is about', () => {
        const onNavigate = vi.fn();
        const phase = { key: 'compliance', status: 'awaiting', attempt: 0, artifacts: { findings: [{ ...FINDINGS[0], link: 'app' }], frameworks: ['GDPR'], facts: { app: { id: 'app_9' }, table: { id: 'tbl_1', name: 'T', columns: [] } } } };
        render(<ComplianceStage playbook={PB} phase={phase} dispatch={vi.fn()} t={t} onNavigate={onNavigate} />);
        fireEvent.click(screen.getByTestId('playbook-compliance-goto'));
        expect(onNavigate).toHaveBeenCalledWith('studio/apps/app_9');
    });
});

describe('ComplianceStage — the verdict, and fixing what it found', () => {
    const FACTS = {
        table: {
            id: 'tbl_1', name: 'Invoice BI Automator',
            columns: [{ key: 'supplier', name: 'Supplier' }, { key: 'invoice_date', name: 'Invoice Date', type: 'date' }, { key: 'contact_email', name: 'Contact Email' }, { key: 'contact_person', name: 'Contact Person' }],
            personal: [{ key: 'contact_email', name: 'Contact Email', kind: 'email', kinds: ['email'] }, { key: 'contact_person', name: 'Contact Person', kind: 'name', kinds: ['name'] }],
            lawfulBasis: null, retentionDays: null, retentionField: null, subjectColumn: null,
        },
        personalMethod: 'values',
        org: { legalBases: ['contract'], defaultRetentionDays: 365 },
        app: { id: 'app_1', name: 'Invoice app' },
        automations: [{ id: 'aut_1', title: 'Read invoices' }],
    };
    const WITH_TARGET = [
        { code: 'ai_no_guard_aut_1', severity: 'medium', framework: 'GDPR', article: 'Art. 25, 32', subject: 'Automation "Read invoices"', title: 'A model reads the data with no privacy check in front of it', why: 'data_extraction reads the content.', fix: 'Add a Privacy Shield step.', source: 'rule', link: 'automation', target: { kind: 'automation', id: 'aut_1', name: 'Read invoices' } },
        { code: 'outbound_aut_1', severity: 'medium', framework: 'GDPR', article: 'Art. 44', subject: 'Automation "Read invoices"', title: 'Personal data leaves the workspace', why: 'It sends e-mail.', fix: 'Check who receives it.', source: 'rule', link: 'automation', target: { kind: 'automation', id: 'aut_1', name: 'Read invoices' } },
    ];
    const phaseWith = (over = {}) => ({
        key: 'compliance', status: 'awaiting', attempt: 0,
        artifacts: { findings: WITH_TARGET, frameworks: ['GDPR'], facts: FACTS, checks: { ran: 9, flagged: 2, clean: 7 }, ...over },
    });

    it('opens with a verdict: what was checked, what came back clean, and how the personal data was judged', () => {
        render(<ComplianceStage playbook={PB} phase={phaseWith()} dispatch={vi.fn()} t={t} />);
        const card = screen.getByTestId('playbook-compliance-verdict');
        expect(card.getAttribute('data-tone')).toBe('tidy');
        expect(screen.getByTestId('playbook-compliance-headline').textContent).toBe('2 things to tidy up');
        expect(screen.getByTestId('playbook-compliance-clean-count').textContent).toContain('7 of 9 checks came back clean');
        // The honesty line: values scanned, not names guessed.
        expect(screen.getByTestId('playbook-compliance-method').textContent).toContain('by reading the values in Contact Email, Contact Person');
    });

    it('a clean reading is green and says so', () => {
        render(<ComplianceStage playbook={PB} phase={phaseWith({ findings: [], checks: { ran: 9, flagged: 0, clean: 9 } })} dispatch={vi.fn()} t={t} />);
        expect(screen.getByTestId('playbook-compliance-verdict').getAttribute('data-tone')).toBe('clear');
        expect(screen.getByTestId('playbook-compliance-headline').textContent).toBe('Nothing to tidy up');
    });

    it('a finding carries a chip that takes you to the automation it found', () => {
        const onNavigate = vi.fn();
        render(<ComplianceStage playbook={PB} phase={phaseWith()} dispatch={vi.fn()} t={t} onNavigate={onNavigate} />);
        const chips = screen.getAllByTestId('playbook-compliance-target');
        expect(chips[0].getAttribute('data-kind')).toBe('automation');
        expect(chips[0].textContent).toContain('Read invoices');
        fireEvent.click(chips[0]);
        expect(onNavigate).toHaveBeenCalledWith('studio/automations/aut_1');
    });

    it('Resolve proposes in words, writes only on Apply, and then reads the review again', async () => {
        const dispatch = vi.fn();
        playbooksApi.resolvePlan.mockResolvedValue({
            plan: {
                code: 'ai_no_guard_aut_1',
                title: 'Put a privacy check in front of the model',
                what: ['Put a "Hide personal data" step in front of "Extract invoice fields".'],
                calls: [{ kind: 'automation_definition', body: { automationId: 'aut_1', definition: { steps: [] } } }],
                unresolved: [], empty: false,
            },
        });
        playbooksApi.runPhase.mockResolvedValue({ playbook: { id: 'pb_1', phases: [] } });
        render(<ComplianceStage playbook={PB} phase={phaseWith()} dispatch={dispatch} t={t} />);

        // Only the one that CAN be fixed offers to be.
        const buttons = screen.getAllByTestId('playbook-compliance-resolve');
        expect(buttons).toHaveLength(1);
        expect(screen.getByTestId('playbook-compliance-manual').textContent).toMatch(/needs you/);

        await act(async () => { fireEvent.click(buttons[0]); });
        await waitFor(() => expect(playbooksApi.resolvePlan).toHaveBeenCalledWith('pb_1', 'compliance', 'ai_no_guard_aut_1'));
        const proposal = screen.getByTestId('playbook-compliance-proposal');
        expect(proposal.textContent).toContain('Put a "Hide personal data" step in front of');
        expect(proposal.textContent).toMatch(/Nothing is written until you press Apply/);
        expect(playbooksApi.runPhase).not.toHaveBeenCalled();

        await act(async () => { fireEvent.click(screen.getByTestId('playbook-compliance-apply')); });
        // The write went out, and THEN the review was read again.
        await waitFor(() => expect(playbooksApi.runPhase).toHaveBeenCalledWith('pb_1', 'compliance', { recheck: true }));
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'replace' }));
    });

    it('a re-read that found fewer says so, which is the whole point of fixing one', () => {
        render(<ComplianceStage playbook={PB} phase={phaseWith({ rechecks: [{ at: '2026-09-16T12:00:00Z', was: 4, now: 2 }] })} dispatch={vi.fn()} t={t} />);
        expect(screen.getByTestId('playbook-compliance-delta').textContent).toBe('2 fewer than a moment ago.');
    });

    it('Check again re-runs the review without moving the phase', async () => {
        const dispatch = vi.fn();
        playbooksApi.runPhase.mockResolvedValue({ playbook: { id: 'pb_1', phases: [] } });
        render(<ComplianceStage playbook={PB} phase={phaseWith()} dispatch={dispatch} t={t} />);
        await act(async () => { fireEvent.click(screen.getByTestId('playbook-compliance-recheck')); });
        expect(playbooksApi.runPhase).toHaveBeenCalledWith('pb_1', 'compliance', { recheck: true });
    });

    it('the registration opens filled in — every derivable field, and never the legal basis', async () => {
        render(<ComplianceStage playbook={PB} phase={phaseWith()} dispatch={vi.fn()} t={t} />);
        // Everything that is a FACT about the table is filled in; the one
        // field that is a legal judgement is not, and the panel says why.
        expect(screen.getByTestId('playbook-compliance-basis').value).toBe('');
        expect(screen.getByTestId('playbook-compliance-basis-open').textContent).toContain('Nothing here picks one for you');
        // The organisation's own grounds are still put at the top of the list.
        const options = [...screen.getByTestId('playbook-compliance-basis').options].map((o) => o.value);
        expect(options[0]).toBe('');
        expect(options[1]).toBe('contract');
        expect(screen.getByTestId('playbook-compliance-retention').value).toBe('365');
        // And a number that was worked out for them says so.
        expect(screen.getByTestId('playbook-compliance-retention-derived')).toBeTruthy();
        // The two the person used to have to find themselves. An invoice date
        // says when the document is dated; retention runs from when we got the
        // row, which every datatable stamps.
        expect(screen.getByTestId('playbook-compliance-retention-field').value).toBe('created_at');
        expect(screen.getByTestId('playbook-compliance-subject').value).toBe('contact_person');
        // Personal data is plural, and the record says so.
        const cats = screen.getByTestId('playbook-compliance-categories').textContent;
        expect(cats).toContain('Contact Person');
        expect(cats).toContain('Contact Email');
    });

    it('the retention period is read against the rows that are really there', async () => {
        render(<ComplianceStage playbook={PB} phase={phaseWith()} dispatch={vi.fn()} t={t} />);
        await waitFor(() => expect(playbooksApi.retentionPreview).toHaveBeenCalledWith('pb_1', 'compliance', { retentionField: 'created_at', retentionDays: 365 }));
        await waitFor(() => expect(screen.getByTestId('playbook-compliance-retention-check').textContent)
            .toContain('The oldest row is 412 days old — 3 of 32 rows fall outside a 365-day window'));
    });

    it('a date column holding no dates is called out — that is a period that never fires', async () => {
        playbooksApi.retentionPreview.mockResolvedValueOnce({ usable: false, retentionField: 'supplier', retentionFieldName: 'Supplier', retentionDays: 365, rowCount: 32, outsideWindow: 0 });
        render(<ComplianceStage playbook={PB} phase={phaseWith()} dispatch={vi.fn()} t={t} />);
        await waitFor(() => expect(screen.getByTestId('playbook-compliance-retention-check').textContent)
            .toContain('holds no readable dates, so nothing would ever be deleted'));
    });
});

describe('ComplianceStage — fixing what the AI itself noticed', () => {
    const FACTS = {
        table: {
            id: 'tbl_1', name: 'HR Resume Manager',
            columns: [{ key: 'candidate_name', name: 'Candidate Name' }, { key: 'email', name: 'Email' }],
            personal: [{ key: 'candidate_name', name: 'Candidate Name', kind: 'name', kinds: ['name'] }],
            lawfulBasis: null, retentionDays: null, retentionField: null, subjectColumn: null,
        },
        personalMethod: 'names',
        org: { legalBases: [], defaultRetentionDays: null },
    };
    // Exactly the screenshot: the model noticed it, so the code is `ai_0` —
    // and it used to get "this one needs you" while the rule beside it had a
    // working button (owner, 2026-09-17).
    const AI_BASIS = {
        code: 'ai_0', severity: 'high', framework: 'GDPR', article: 'Art. 13',
        subject: 'HR Resume Manager', title: 'Missing lawful basis for processing',
        why: "The table 'HR Resume Manager' has lawfulBasis set to null.",
        fix: 'Assign a lawful basis to the HR Resume Manager table.',
        source: 'ai', link: 'table', target: { kind: 'table', id: 'tbl_1', name: 'HR Resume Manager' },
        fix_kind: 'registration',
    };
    const phase = {
        key: 'compliance', status: 'awaiting', attempt: 0,
        artifacts: { findings: [AI_BASIS], frameworks: ['GDPR'], facts: FACTS, checks: { ran: 4, flagged: 1, clean: 3 } },
    };

    it('a finding the model wrote gets the same Resolve as the rule that says the same thing', () => {
        render(<ComplianceStage playbook={PB} phase={phase} dispatch={vi.fn()} t={t} />);
        expect(screen.getByTestId('playbook-compliance-resolve')).toBeTruthy();
        expect(screen.queryByTestId('playbook-compliance-manual')).toBeNull();
    });

    it('a table with no date of its own still opens with a retention date — the one the platform stamps', async () => {
        render(<ComplianceStage playbook={PB} phase={phase} dispatch={vi.fn()} t={t} />);
        // "There is no column created_at in this table" was our own validator
        // being wrong: every datatable has it and the clean-up ages rows by it.
        expect(screen.getByTestId('playbook-compliance-retention-field').value).toBe('created_at');
        const options = [...screen.getByTestId('playbook-compliance-retention-field').querySelectorAll('option')].map((o) => o.textContent);
        expect(options).toContain('When the row was added');
        // No period is suggested (this organisation set no default), so there
        // is nothing to read the table against yet — and nothing is claimed.
        expect(screen.getByTestId('playbook-compliance-retention').value).toBe('');
        expect(playbooksApi.retentionPreview).not.toHaveBeenCalled();
    });

    it('the register panel fills itself in with AI, and still writes nothing until Register', async () => {
        playbooksApi.resolvePlan.mockResolvedValue({
            plan: {
                code: 'ai_0', title: 'Record this processing',
                what: ['Record a legal obligation as the legal basis.'],
                note: 'Resumes must be kept for the duration of the application.',
                calls: [{ kind: 'register', body: { registration: { lawfulBasis: 'legal_obligation', retentionDays: 730, retentionField: 'created_at', subjectColumn: 'candidate_name' } } }],
                unresolved: [], empty: false,
            },
        });
        render(<ComplianceStage playbook={PB} phase={phase} dispatch={vi.fn()} t={t} />);
        await act(async () => { fireEvent.click(screen.getByTestId('playbook-compliance-suggest')); });
        // A model proposal DOES fill the field — the person asked for it by
        // pressing the button, and the gate below is still the only writer.
        await waitFor(() => expect(screen.getByTestId('playbook-compliance-basis').value).toBe('legal_obligation'));
        expect(screen.queryByTestId('playbook-compliance-basis-open')).toBeNull();
        expect(screen.getByTestId('playbook-compliance-retention').value).toBe('730');
        expect(screen.getByTestId('playbook-compliance-subject').value).toBe('candidate_name');
        expect(screen.getByTestId('playbook-compliance-suggestion').textContent).toContain('Resumes must be kept');
        // It filled the FORM. The gate below is still the only writer.
        expect(playbooksApi.register).not.toHaveBeenCalled();
    });
});
