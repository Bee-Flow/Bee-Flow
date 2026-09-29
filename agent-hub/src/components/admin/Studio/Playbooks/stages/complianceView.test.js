import { describe, expect, it } from 'vitest';
import { basisOptions, dateColumns, groupFindings, isResolvable, linkFor, methodLine, registrationDefaults, registrationSources, retentionWords, severityWord, subjectColumns, targetWords, verdictOf, writtenWords } from './complianceView';

const t = (k, f, v) => (v ? Object.entries(v).reduce((s, [a, b]) => s.replace(`{${a}}`, String(b)), f) : f);

const TABLE = {
    id: 'tbl_1', name: 'Invoice BI Automator',
    columns: [
        { key: 'supplier', name: 'Supplier', type: 'text' },
        { key: 'due_date', name: 'Due Date', type: 'date' },
        { key: 'created_at', name: 'Created At', type: 'date' },
        { key: 'contact_email', name: 'Contact Email', type: 'text' },
        { key: 'contact_person', name: 'Contact Person', type: 'text' },
    ],
    personal: [
        { key: 'contact_email', name: 'Contact Email', kind: 'email', kinds: ['email'] },
        { key: 'contact_person', name: 'Contact Person', kind: 'name', kinds: ['name'] },
    ],
};

describe('complianceView — what the phase shows', () => {
    it('a finding links to the thing it found, whatever shape it came back in', () => {
        expect(linkFor({ target: { kind: 'automation', id: 'aut_1' } })).toBe('studio/automations/aut_1');
        expect(linkFor({ target: { kind: 'table', id: 'tbl_1' } })).toBe('studio/datatables/tbl_1');
        expect(linkFor({ target: { kind: 'app', id: 'app_1' } })).toBe('studio/apps/app_1');
        // The register is a place, not a thing.
        expect(linkFor({ link: 'register' })).toBe('settings/organisation/compliance/ropa');
        // A finding stored before targets existed still knows where to go.
        expect(linkFor({ link: 'app' }, { app: { id: 'app_9' } })).toBe('studio/apps/app_9');
        expect(linkFor({ link: 'automation' })).toBeNull();
        expect(linkFor({})).toBeNull();
    });

    it('a target reads as what it is, not just a name', () => {
        expect(targetWords({ target: { kind: 'automation', id: 'a', name: 'Read invoices' } }, t)).toEqual({ kind: 'automation', label: 'Automation', name: 'Read invoices' });
        expect(targetWords({ subject: 'Automation "x"' }, t)).toBeNull();
    });

    it('severity is a word about this build, not a weight on a score', () => {
        expect(severityWord('high', t)).toBe('Fix before you share');
        expect(severityWord('medium', t)).toBe('Worth doing');
        expect(severityWord('low', t)).toBe('Good to know');
        expect(severityWord(undefined, t)).toBe('Good to know');
    });

    it('the verdict states what was checked, and claims nothing it cannot', () => {
        const some = verdictOf({ findings: [{ severity: 'high' }, { severity: 'low' }], checks: { ran: 9, flagged: 2, clean: 7 } }, t);
        expect(some.headline).toBe('2 things to tidy up');
        expect(some.cleanLine).toBe('7 of 9 checks came back clean');
        expect(some.tone).toBe('attention');
        expect(verdictOf({ findings: [{ severity: 'low' }], checks: { ran: 3, clean: 2 } }, t).tone).toBe('tidy');
        expect(verdictOf({ findings: [], checks: { ran: 9, clean: 9 } }, t).tone).toBe('clear');
        // A review stored before `checks` existed says what it found and no more.
        const old = verdictOf({ findings: [{ severity: 'low' }] }, t);
        expect(old.cleanLine).toBeNull();
    });

    it('it says HOW the personal data was judged — the whole difference between a fact and a guess', () => {
        expect(methodLine({ personalMethod: 'values', table: TABLE }, t)).toContain('by reading the values in Contact Email, Contact Person');
        expect(methodLine({ personalMethod: 'names', table: TABLE }, t)).toContain('assumed from the column names');
        expect(methodLine({ personalMethod: 'values', table: { personal: [] } }, t)).toBeNull();
    });

    it('notes fold away; the things that matter do not', () => {
        const g = groupFindings([{ severity: 'high' }, { severity: 'medium' }, { severity: 'low' }, { severity: undefined }]);
        expect(g.high).toHaveLength(1);
        expect(g.medium).toHaveLength(1);
        expect(g.low).toHaveLength(2);
    });

    it('the review decides what can be fixed — including the findings it wrote itself', () => {
        // The stamp wins: this is how "Missing lawful basis for processing",
        // which the model wrote as `ai_0`, gets the same button as the rule.
        expect(isResolvable({ code: 'ai_0', fix_kind: 'registration' })).toBe(true);
        expect(isResolvable({ code: 'ai_1' })).toBe(false);
        // Findings stored before the stamp existed still work off their code.
        expect(isResolvable({ code: 'ropa_retention' })).toBe(true);
        expect(isResolvable({ code: 'outbound_aut_1' })).toBe(false);
        expect(isResolvable('ai_no_guard_aut_1')).toBe(true);
        expect(isResolvable('personal_data_public_page')).toBe(false);
    });

    it('the registration opens filled in, from what is really there', () => {
        const facts = { table: TABLE, org: { legalBases: ['contract'], defaultRetentionDays: 365 } };
        const d = registrationDefaults(facts);
        // The legal basis is BLANK, and that is the point. It used to open on
        // `org.legalBases[0]`, so Register was one click away from recording a
        // legal position nobody had taken — Art. 6(1)(f) especially is a
        // balancing test with a documented assessment behind it, not a default.
        expect(d).toEqual({ lawfulBasis: '', retentionDays: 365, retentionField: 'created_at', subjectColumn: 'contact_person' });
        // Everything that IS a fact about the table is filled in, and says
        // where it came from — a derived value and a recorded one look the
        // same in a form field and mean different things on an Art. 30 record.
        expect(registrationSources(facts)).toEqual({ retentionDays: 'derived', retentionField: 'derived', subjectColumn: 'derived' });
        expect(registrationSources({ table: { ...TABLE, retentionDays: 30, retentionField: 'due_date', subjectColumn: 'supplier' }, org: {} }))
            .toEqual({ retentionDays: 'recorded', retentionField: 'recorded', subjectColumn: 'recorded' });
        // The organisation's own grounds are offered FIRST — a shortlist is
        // help; picking from it is the part only the customer can do.
        expect(basisOptions(facts, ['consent', 'contract', 'legal_obligation'])).toEqual([
            { id: 'contract', configured: true },
            { id: 'consent', configured: false },
            { id: 'legal_obligation', configured: false },
        ]);
        expect(basisOptions({ org: {} }, ['consent'])).toEqual([{ id: 'consent', configured: false }]);
        // "created" beats "due"; a name beats an e-mail address. The table
        // declares its own created_at here, so the system stamp is not offered
        // twice — only `updated_at` joins the list.
        expect(dateColumns(TABLE).map((c) => c.key)).toEqual(['created_at', 'due_date', 'updated_at']);
        expect(subjectColumns(TABLE).map((c) => c.key)).toEqual(['contact_person', 'contact_email']);
        // What the table already records wins over any suggestion.
        const recorded = registrationDefaults({ table: { ...TABLE, lawfulBasis: 'consent', retentionDays: 90, retentionField: 'due_date', subjectColumn: 'supplier' }, org: { legalBases: ['contract'] } });
        expect(recorded).toEqual({ lawfulBasis: 'consent', retentionDays: 90, retentionField: 'due_date', subjectColumn: 'supplier' },
            'a basis already on the row is the customer\'s own earlier answer and stands');
        // Nothing to go on: blank basis, blank subject — but a retention date
        // is always available, because every datatable stamps created_at and
        // the clean-up ages rows by it. "When the row was added" is when the
        // automation extracted it (owner, 2026-09-17).
        expect(registrationDefaults({ table: { columns: [{ key: 'x', name: 'X', type: 'text' }], personal: [] }, org: {} }))
            .toEqual({ lawfulBasis: '', retentionDays: '', retentionField: 'created_at', subjectColumn: '' });
    });

    it('a table whose only date is a business date is still counted from when the row arrived', () => {
        // An invoice date says when the document is dated; Art. 5(1)(e) asks
        // how long WE keep it. Only a column that reads as created/received
        // wins over the stamp.
        const business = { columns: [{ key: 'invoice_date', name: 'Invoice Date', type: 'date' }], personal: [] };
        expect(dateColumns(business).map((c) => c.key)).toEqual(['created_at', 'updated_at', 'invoice_date']);
        const received = { columns: [{ key: 'received_on', name: 'Received On', type: 'date' }], personal: [] };
        expect(dateColumns(received).map((c) => c.key)[0]).toBe('received_on');
        // It is named in words a person reads, not as a column key.
        expect(dateColumns(business, (k, en) => en)[0].name).toBe('When the row was added');
    });

    it('what the register wrote is said in sentences, not in its own field names', () => {
        expect(writtenWords({ written: ['processing_register', 'risks:2', 'evidence'] }, t)).toEqual([
            'the table is in the processing register',
            '2 items opened in the risk register',
            'this review is on the evidence chain',
        ]);
        expect(writtenWords(null, t)).toEqual([]);
    });

    it('a retention period is explained by the rows that exist', () => {
        expect(retentionWords({ usable: true, oldestDays: 412, outsideWindow: 3, rowCount: 32, retentionDays: 365 }, t))
            .toEqual({ tone: 'warning', line: 'The oldest row is 412 days old — 3 of 32 rows fall outside a 365-day window and would be removed.' });
        expect(retentionWords({ usable: true, oldestDays: 40, outsideWindow: 0, rowCount: 32, retentionDays: 365 }, t).tone).toBe('success');
        // The case that matters most: a period recorded that can never fire.
        expect(retentionWords({ usable: false, retentionFieldName: 'Supplier' }, t).line).toContain('"Supplier" holds no readable dates');
        expect(retentionWords(null, t)).toBeNull();
    });
});
