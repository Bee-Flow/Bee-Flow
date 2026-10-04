/** The forms readers on answers shaped as the server sends them — and on the answers it should not. */

import { readAnswerRow, readAnswerRows, readAnswersSummary } from './answerReaders';
import { readFillAck, readFillSession, readFillStart, readPickResults, readUploadedFile } from './fillReaders';
import { readAiDraft, readAudienceResponse, readFormDetail, readForms } from './readers';

const TOKEN = 'c'.repeat(48);

describe('the directory and one form', () => {
    it('reads a directory row, the owner’s audience and the answers table', () => {
        const [row] = readForms({
            forms: [
                {
                    id: TOKEN, url: `/f/${TOKEN}`, automationId: 'a1', triggerStepId: null, title: 'Intake', description: null,
                    live: true, submissions: 3, lastSeenAt: '2026-09-01T10:00:00Z', createdAt: null, mine: true, canOpen: true,
                    audience: { mode: 'restricted', groups: ['g1'], users: ['u1', 7] },
                    answers: { collecting: true, datatableId: 't1', grade: 'owner', rowCount: '12', linked: true, lastWriteError: { code: 'x', message: 'Nope' } },
                },
            ],
        });
        expect(row).toMatchObject({ id: TOKEN, automationId: 'a1', mine: true, canOpen: true, submissions: 3 });
        expect(row?.audience).toEqual({ mode: 'restricted', groups: ['g1'], users: ['u1'] });
        expect(row?.answers).toEqual({ collecting: true, datatableId: 't1', grade: 'owner', rowCount: 12, linked: true, lastWriteError: { code: 'x', message: 'Nope' } });
    });

    it('reads a colleague’s row fail-closed, and an older row as fillable', () => {
        const [row] = readForms({ forms: [{ id: 'x', automationId: 'a2', audience: { mode: 'odd' } }] });
        expect(row).toMatchObject({ mine: false, canOpen: true, answers: null, audience: { mode: 'org', groups: [], users: [] } });
        expect(readForms({ nope: true })).toEqual([]);
    });

    it('reads the Form page: questions, later pages and — for the owner — the definition', () => {
        const detail = readFormDetail({
            form: {
                id: TOKEN, automationId: 'a1', title: 'Intake', mine: true, isActive: false, isDraft: true,
                questions: { title: 'Intake', collect: true, fields: [{ name: 'n', type: 'text', label: 'Name', required: true }, { type: 'text' }], theme: { primary: '#000' } },
                pages: [{ stepId: 's2', label: 'Page two', fields: [{ name: 'more', type: 'textarea' }] }],
                definition: { trigger: { kind: 'form' } },
                automationTitle: 'Intake automation',
            },
        });
        expect(detail?.questions.fields.map((f) => f.name)).toEqual(['n']);
        expect(detail?.pages[0]).toMatchObject({ stepId: 's2', label: 'Page two' });
        expect(detail?.definition).toEqual({ trigger: { kind: 'form' } });
        expect(readFormDetail({ form: { id: 'x' } })).toBeNull();
        expect(readFormDetail(null)).toBeNull();
    });

    it('reads a saved audience and an AI draft', () => {
        expect(readAudienceResponse({ audience: { mode: 'org', groups: [], users: [] } }).mode).toBe('org');
        expect(readAiDraft({ draft: { form: { title: 'T', fields: [{ name: 'a' }] }, notes: 'Two left out.' } })).toEqual({
            form: { title: 'T', fields: [{ name: 'a' }] },
            notes: 'Two left out.',
        });
        expect(readAiDraft({ draft: { form: { title: 'T' } } })).toBeNull();
    });
});

describe('the answers', () => {
    it('reads the dashboard in one answer', () => {
        const summary = readAnswersSummary({
            table: { id: 't1', name: 'Intake answers', rowCount: 4, retentionDays: null },
            range: { from: '2026-09-01', to: '2026-09-30', bucket: 'day' },
            totals: { all: '4', inRange: 3, last7d: 1, today: 0, completed: 3, open: 0, lastAt: '2026-09-20T10:00:00.000Z' },
            timeline: [{ bucket: '2026-09-20', n: '2' }],
            questions: [
                { fieldId: 'f1', key: 'team', label: 'Team', formType: 'select', columnType: 'select', answered: 3, skipped: 0, breakdown: { kind: 'choice', values: [{ value: 'Sales', n: 2, pct: 66.7 }] } },
                { fieldId: 'f2', key: 'ok', label: 'OK', columnType: 'bool', breakdown: { kind: 'yesno', yes: 2, no: 1 } },
                { fieldId: 'f3', key: 'age', label: 'Age', columnType: 'number', breakdown: { kind: 'number', avg: 30.5, min: 20, max: 41, p50: null } },
                { fieldId: 'f4', key: 'x', label: 'X', breakdown: { kind: 'future' } },
                { fieldId: 'f5', label: 'no key' },
            ],
            recent: [{ rowId: 'r1', submittedAt: '2026-09-20T10:00:00.000Z', runId: 'run1', by: { id: 'u1', name: 'Anna' }, preview: { team: 'Sales', age: 30 } }, { preview: {} }],
        });
        expect(summary.totals.all).toBe(4);
        expect(summary.timeline).toEqual([{ bucket: '2026-09-20', n: 2 }]);
        expect(summary.questions.map((q) => q.breakdown?.kind ?? null)).toEqual(['choice', 'yesno', 'number', null]);
        expect(summary.recent).toHaveLength(1);
        expect(summary.recent[0]?.preview).toEqual({ team: 'Sales', age: null });
    });

    it('reads a page of rows and one row', () => {
        const page = readAnswerRows({ rows: [{ id: 1, created_at: 'x' }, { nope: true }, 'junk'], hasMore: true, nextCursor: 'cur', total: 9 });
        expect(page.rows.map((r) => r.id)).toEqual(['1']);
        expect(page).toMatchObject({ hasMore: true, nextCursor: 'cur', total: 9 });
        expect(readAnswerRow(null)).toBeNull();
    });
});

describe('filling a form in', () => {
    it('reads page one with its CSRF', () => {
        const start = readFillStart({
            form: {
                title: 'Intake', description: 'Hi', submitLabel: 'Send', successMessage: 'Thanks', theme: { primary: '#0F766E' }, multiPage: true,
                fields: [{ name: 'team', type: 'select', label: '', options: [{ value: 'a', label: '' }, { value: '', label: 'x' }] }],
            },
            csrf: 'tok',
            issuedAt: 123,
        });
        expect(start).toMatchObject({ csrf: 'tok', issuedAt: 123 });
        expect(start.form.multiPage).toBe(true);
        expect(start.form.fields[0]).toMatchObject({ label: 'team', options: [{ value: 'a', label: 'a' }] });
    });

    it('reads every session state, and anything unknown as an error — never as "working"', () => {
        expect(readFillSession({ state: 'working', progress: ['A', 1], progressNote: 'n' })).toEqual({ state: 'working', progress: ['A'], progressNote: 'n' });
        expect(readFillSession({ state: 'form', stepId: 's2', form: { title: 'Two' }, csrf: 'c', issuedAt: 1 })).toMatchObject({ state: 'form', stepId: 's2', csrf: 'c' });
        expect(readFillSession({ state: 'done', ending: null })).toEqual({ state: 'done', ending: null });
        expect(readFillSession({ state: 'done', ending: { title: 'Done' } })).toMatchObject({ state: 'done', ending: { title: 'Done' } });
        expect(readFillSession({ state: 'expired' })).toEqual({ state: 'expired' });
        expect(readFillSession({ state: 'paused-forever' })).toEqual({ state: 'error' });
    });

    it('reads a take, an upload and a search', () => {
        expect(readFillAck({ accepted: true, sessionId: 'sid' })).toEqual({ accepted: true, sessionId: 'sid', duplicate: false });
        expect(readFillAck({ accepted: true, duplicate: true })).toEqual({ accepted: true, sessionId: null, duplicate: true });
        expect(readUploadedFile({ fileId: 'f1', filename: 'cv.pdf', size: 10, mimeType: 'application/pdf' })).toEqual({ fileId: 'f1', filename: 'cv.pdf', size: 10, mimeType: 'application/pdf' });
        expect(readPickResults({ results: [{ id: 'r1', title: 'Call' }, { title: 'no id' }], error: 'Not connected' })).toEqual({
            results: [{ id: 'r1', title: 'Call', subtitle: '' }],
            error: 'Not connected',
        });
    });
});
