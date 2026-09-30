/** The Form page's pure rules: routing a token, tabs, the audience, the draft, the preview and the dashboard's words. */

import { ApiError } from '@/core/api/client';

import { draftBody, draftErrorWords } from './aiDraft';
import { answerText, bucketLabel, choiceScale, completionPercent, isMultiPage, previewLine, splitQuestions } from './answersView';
import type { AnswerQuestion } from './answerTypes';
import { granteesOf, initialsOf, withGrantee, withMode, withoutGrantee } from './audience';
import { formLook } from './formLook';
import { audienceGist, formFillPath, formPagePath, initialTab, listTarget, resolveFormRef } from './formPage';
import { acceptTypes } from './pickFile';
import { previewForm } from './preview';
import { cloneForm, sameForm, triggerFormOf, withTriggerForm } from './questionsDraft';
import { parkSeed, takeSeed } from './seeds';
import { answersTablePath } from './tableLink';
import type { FormSummary } from './types';

jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));

const TOKEN = 'a'.repeat(48);
const summary = (patch: Partial<FormSummary>): FormSummary => ({
    id: TOKEN,
    url: `/f/${TOKEN}`,
    automationId: '3f2b6c1e-0000-4000-8000-000000000001',
    triggerStepId: null,
    title: 'Intake',
    description: null,
    live: true,
    submissions: 0,
    lastSeenAt: null,
    createdAt: null,
    mine: false,
    canOpen: true,
    audience: { mode: 'org', groups: [], users: [] },
    answers: null,
    ...patch,
});

describe('the Form page route', () => {
    it('keeps the token out of the route: a token resolves to its routine, a routine id is taken as it is', () => {
        const forms = [summary({})];
        expect(resolveFormRef('3f2b6c1e-0000-4000-8000-000000000001', undefined)).toEqual({ automationId: '3f2b6c1e-0000-4000-8000-000000000001', redirect: false });
        expect(resolveFormRef(TOKEN, undefined)).toBeNull();
        expect(resolveFormRef(TOKEN, forms)).toEqual({ automationId: '3f2b6c1e-0000-4000-8000-000000000001', redirect: true });
        expect(resolveFormRef('b'.repeat(48), forms)).toEqual({ automationId: 'b'.repeat(48), redirect: false });
    });

    it('opens a form’s page for its owner and a reader of its answers, and filling it in for anyone else who may', () => {
        expect(listTarget(summary({ mine: true }))).toEqual({ kind: 'page', automationId: '3f2b6c1e-0000-4000-8000-000000000001' });
        expect(listTarget(summary({ answers: { collecting: true, datatableId: 't1', grade: 'viewer', rowCount: 3, linked: true, lastWriteError: null } }))?.kind).toBe('page');
        expect(listTarget(summary({}))).toEqual({ kind: 'fill', token: TOKEN });
        expect(listTarget(summary({ canOpen: false }))).toBeNull();
    });

    it('opens on the tab asked for when it is allowed', () => {
        expect(initialTab(true, 'share')).toBe('share');
        expect(initialTab(true, 'nope')).toBe('questions');
        expect(initialTab(false, 'questions')).toBe('answers');
        expect(formPagePath('a b')).toBe('/forms/a%20b');
        expect(formFillPath(TOKEN)).toBe(`/forms/fill/${TOKEN}`);
    });

    it('opens the answers table on the phone’s own table screen, on its rows unless asked', () => {
        expect(answersTablePath('t1')).toEqual({ pathname: '/datatables/[id]', params: { id: 't1', tab: 'rows' } });
        expect(answersTablePath('t1', 'retention')).toEqual({ pathname: '/datatables/[id]', params: { id: 't1', tab: 'retention' } });
    });
});

describe('the audience', () => {
    const empty = { mode: 'restricted' as const, groups: [], users: [] };
    it('adds each person or group once, removes them, and keeps the list when widened', () => {
        const one = withGrantee(withGrantee(empty, { type: 'user', id: 'u1' }), { type: 'user', id: 'u1' });
        const two = withGrantee(one, { type: 'group', id: 'g1' });
        expect(granteesOf(two)).toEqual([{ type: 'group', id: 'g1' }, { type: 'user', id: 'u1' }]);
        expect(withoutGrantee(two, { type: 'user', id: 'u1' }).users).toEqual([]);
        expect(withMode(two, 'org')).toEqual({ ...two, mode: 'org' });
        expect(audienceGist(two)).toEqual({ kind: 'some', count: 2 });
        expect(audienceGist(empty)).toEqual({ kind: 'nobody' });
        expect(audienceGist(withMode(two, 'org'))).toEqual({ kind: 'org' });
    });

    it('draws initials', () => {
        expect(initialsOf('Anna de Vries')).toBe('AD');
        expect(initialsOf('')).toBe('?');
    });
});

describe('the questions draft', () => {
    const definition = { trigger: { id: 'trg', type: 'trigger' as const, kind: 'form', form: { title: 'A', fields: [] } }, steps: [], edges: [] };
    it('reads and replaces only the trigger’s form', () => {
        expect(triggerFormOf(definition)).toEqual({ title: 'A', fields: [] });
        expect(triggerFormOf({ ...definition, trigger: { ...definition.trigger, kind: 'manual' } })).toBeNull();
        const next = withTriggerForm(definition, { title: 'B', fields: [] });
        expect(next.trigger?.kind).toBe('form');
        expect(triggerFormOf(next)?.title).toBe('B');
        expect(next.steps).toBe(definition.steps);
    });

    it('copies deeply and compares by value', () => {
        const form = { title: 'A', fields: [{ name: 'x', type: 'text' }] };
        const copy = cloneForm(form);
        expect(copy).not.toBe(form);
        expect(sameForm(copy, form)).toBe(true);
        expect(sameForm({ ...copy, title: 'B' }, form)).toBe(false);
    });
});

describe('the AI draft', () => {
    it('sends a brief to create and a note to revise, with the current form either way', () => {
        expect(draftBody('create', ' a leave form ', { fields: [] })).toEqual({ mode: 'create', brief: 'a leave form', current: { fields: [] } });
        expect(draftBody('revise', 'add a phone', { fields: [] })).toEqual({ mode: 'revise', note: 'add a phone', current: { fields: [] } });
    });

    it('words the refusals the web words', () => {
        expect(draftErrorWords(new ApiError('x', { status: 503, body: { code: 'no_model' } }))?.key).toBe('forms.ai.err_no_model');
        expect(draftErrorWords(new ApiError('x', { status: 429, body: {} }))?.key).toBe('forms.ai.err_rate');
        expect(draftErrorWords(Object.assign(new Error('u'), { code: 'ai_unusable' }))?.key).toBe('forms.ai.err_unusable');
        expect(draftErrorWords(new Error('other'))).toBeNull();
    });
});

it('hands a parked brief over once, to its own form only', () => {
    parkSeed('a1', '  a brief ');
    expect(takeSeed('a2')).toBeNull();
    expect(takeSeed('a1')).toBe('a brief');
    expect(takeSeed('a1')).toBeNull();
});

describe('the preview', () => {
    it('renders a declaration as the server would: bad names dropped, choices normalised, defaults filled', () => {
        const form = previewForm({
            title: '',
            fields: [
                { name: 'ok', type: 'select', options: ['A', { value: 'b', label: 'B' }, ''] },
                { name: '1bad', type: 'text' },
                { name: 'ok', type: 'text' },
                { name: 'file', type: 'file', maxSizeMb: 90 },
                { name: 'odd', type: 'weird' },
            ],
        });
        expect(form.title).toBe('Form');
        expect(form.fields.map((f) => [f.name, f.type])).toEqual([['ok', 'select'], ['file', 'file'], ['odd', 'text']]);
        expect(form.fields[0]?.options).toEqual([{ value: 'A', label: 'A' }, { value: 'b', label: 'B' }]);
        expect(form.fields[1]?.maxSizeMb).toBe(25);
    });
});

describe('the dashboard’s words', () => {
    const q = (patch: Partial<AnswerQuestion>): AnswerQuestion => ({
        fieldId: 'f', key: 'k', label: 'L', formType: 'text', columnType: 'text', pageStepId: null, retired: false, answered: 0, skipped: 0, breakdown: null, ...patch,
    });

    it('splits retired questions off and knows a multi-page form', () => {
        const questions = [q({ key: 'a' }), q({ key: 'b', retired: true })];
        expect(splitQuestions(questions).retired.map((x) => x.key)).toEqual(['b']);
        const totals = { all: 1, inRange: 4, last7d: 1, today: 0, completed: 3, open: 0, lastAt: null };
        expect(isMultiPage({ totals, questions })).toBe(false);
        expect(isMultiPage({ totals: { ...totals, open: 1 }, questions })).toBe(true);
        expect(isMultiPage({ totals, questions: [q({ pageStepId: 's2' })] })).toBe(true);
        expect(completionPercent(totals)).toBe('75%');
        expect(completionPercent({ completed: 0, inRange: 0 })).toBeNull();
    });

    it('turns answers into words', () => {
        const words = { yes: 'Yes', no: 'No' };
        expect(answerText(true, 'bool', words)).toBe('Yes');
        expect(answerText('', 'text', words)).toBe('—');
        expect(answerText({ kind: 'form_upload', filename: 'cv.pdf' }, 'file', words)).toBe('cv.pdf');
        expect(answerText(['a', 'b'], 'text', words)).toBe('a, b');
        expect(previewLine({ preview: { a: 'Anna', b: null, c: '', d: 'x', e: 'y' } })).toBe('Anna · x · y');
        expect(choiceScale([{ n: 2 }, { n: 5 }])).toBe(5);
        expect(bucketLabel('garbage', 'day')).toBe('garbage');
    });
});

it('draws a form in its author’s accent and corners', () => {
    expect(formLook({ primary: '#1D4ED8', radius: 'xl', density: 'spacious' })).toEqual({ primary: '#1D4ED8', onPrimary: '#ffffff', radius: 16, gap: 25 });
    expect(formLook(null)).toMatchObject({ primary: '#0F766E', radius: 8, gap: 20 });
});

it('filters the file picker by the question’s MIME types', () => {
    expect(acceptTypes('application/pdf, image/*,.docx')).toEqual(['application/pdf', 'image/*']);
    expect(acceptTypes('')).toEqual(['*/*']);
});
