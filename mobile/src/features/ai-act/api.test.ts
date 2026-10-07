/**
 * The AI Act read and write for either kind: their paths, and how their
 * answers are read — the shapes routes/compliance/aiAct.js (with
 * compliance/aiAct/signals.js) answer with, pinned against the source below.
 */

import fs from 'node:fs';
import path from 'node:path';

import { api, ApiError } from '@/core/api/client';

import { enableMarking, getAiActAssessment, getAiActSignals, listAiActAssessments, readAssessment, saveAiActAssessment, type AiActAnswersBody } from './api';

jest.mock('@/core/api/client', () => {
    const actual = jest.requireActual('@/core/api/client');
    return { ...actual, api: { get: jest.fn(), post: jest.fn(), put: jest.fn() } };
});

const SERVER = path.resolve(__dirname, '../../../../server');

beforeEach(() => jest.clearAllMocks());

describe('the AI Act assessment', () => {
    it('reads the saved declaration and its signals', async () => {
        (api.get as jest.Mock).mockResolvedValue({
            outcome: 'minimal', attested_at: '2026-09-01T10:00:00Z', expires_at: '2027-09-01T10:00:00Z', current: true,
            signals: {
                contains_ai: true, customer_facing: false, generates_content: true, disclosure_present: false, marking_enabled: true,
                steps: { ai: [{ id: 's1', label: 'Classify' }, { id: 's2', label: '' }] },
                annex_iii_questions: [{ id: 'employment', hint: true }, { id: 'credit', hint: false }, { hint: true }],
            },
            answers: {
                art5: { answer: 'no', practices: [] },
                art50: { interacts: 'no' },
                annex_iii: { answer: 'unknown', category: null, domains: { credit: 'yes', employment: 'no', biometrics: 'unknown' } },
            },
        });
        const read = await getAiActAssessment('automation', 'a1');
        expect(api.get).toHaveBeenCalledWith('/api/compliance/ai-act/assessments/automation/a1');
        expect(read).toEqual({
            outcome: 'minimal', attestedAt: '2026-09-01T10:00:00Z', expiresAt: '2027-09-01T10:00:00Z', current: true,
            signals: {
                containsAi: true, customerFacing: false, generatesContent: true, disclosurePresent: false, markingEnabled: true,
                aiSteps: 2, aiStepLabels: ['Classify'], annexHints: ['employment'], stepCount: null, surface: null,
            },
            answers: { art5: 'no', annexIii: null, annexCategory: null, annexDomains: { credit: 'yes', employment: 'no' } },
        });
    });

    it('reads a never-assessed automation as no answers and unknown signals', () => {
        expect(readAssessment({ outcome: null, answers: null, signals: {} })).toEqual({
            outcome: null, attestedAt: null, expiresAt: null, current: false,
            signals: {
                containsAi: null, customerFacing: null, generatesContent: null, disclosurePresent: null, markingEnabled: null,
                aiSteps: null, aiStepLabels: [], annexHints: [], stepCount: null, surface: null,
            },
            answers: null,
        });
    });

    it('records the ladder’s answers with a PUT, never retried, and reads the stored row', async () => {
        const answers: AiActAnswersBody = {
            art5: { answer: 'no', practices: [] },
            art50: { interacts: true, disclosure: null, generates: false, marking: true },
            annex_iii: { answer: 'no', category: null, domains: { credit: 'no' } },
        };
        (api.put as jest.Mock).mockResolvedValue({ outcome: 'transparency', attested_at: '2026-09-27T10:00:00Z', expires_at: '2027-09-27T10:00:00Z', current: true, signals: {}, answers: {} });
        const row = await saveAiActAssessment('automation', 'a 1', answers);
        expect(api.put).toHaveBeenCalledWith('/api/compliance/ai-act/assessments/automation/a%201', { answers }, { retry: false });
        expect(row.outcome).toBe('transparency');
        expect(row.attestedAt).toBe('2026-09-27T10:00:00Z');
    });

    it('is null where the routes are not there, and throws any other failure', async () => {
        (api.get as jest.Mock).mockRejectedValueOnce(new ApiError('Not found', { status: 404 }));
        await expect(getAiActAssessment('automation', 'a1')).resolves.toBeNull();
        (api.get as jest.Mock).mockRejectedValueOnce(new ApiError('Forbidden', { status: 403 }));
        await expect(getAiActAssessment('automation', 'a1')).rejects.toThrow('Forbidden');
        expect(readAssessment({ outcome: 'made_up' }).outcome).toBeNull();
    });

    it('matches the route: the path, and the row’s snake_case fields', () => {
        const src = fs.readFileSync(path.join(SERVER, 'routes/compliance/aiAct.js'), 'utf8');
        expect(src).toContain("router.get('/ai-act/assessments/:kind/:id'");
        for (const key of ['outcome: row.outcome', 'attested_at: row.attested_at', 'expires_at: row.expires_at', 'current: aiActAssessmentStore.isCurrent(row)', 'signals: row.signals', 'answers: row.answers']) {
            expect(src).toContain(key);
        }
    });

    it('matches the write: PUT on the same path, `{ answers }` only, answered with the stored row', () => {
        const src = fs.readFileSync(path.join(SERVER, 'routes/compliance/aiAct.js'), 'utf8');
        expect(src).toContain("router.put('/ai-act/assessments/:kind/:id'");
        expect(src).toContain('answers: z.record(z.unknown()');
        expect(src).toContain('}).strict());');
        expect(src).toContain('res.json({ ...(_publicRow(row) || {}), title: _titleOf(t.kind, target), open_duties: result.open_duties });');
    });

    it('matches the signals the checks compute', () => {
        const src = fs.readFileSync(path.join(SERVER, 'compliance/aiAct/signals.js'), 'utf8');
        for (const key of ['contains_ai:', 'customer_facing:', 'generates_content:', 'disclosure_present:', 'marking_enabled:', 'annex_iii_questions:', 'label: _label(x.step)']) {
            expect(src).toContain(key);
        }
        const annex = fs.readFileSync(path.join(SERVER, 'compliance/aiAct/annexIii.js'), 'utf8');
        expect(annex).toContain('id: d.id, point: d.point, article: d.article, label_key: d.labelKey, hint: hinted.has(d.id),');
    });
});

describe('the Systems list, the signals and Enable marking', () => {
    it('reads the list rows, dropping a row without an id', async () => {
        (api.get as jest.Mock).mockResolvedValue([
            { target_kind: 'agent', target_id: 7, title: 'Helpdesk', outcome: 'minimal', attested_at: '2026-09-01', expires_at: null, current: true },
            { target_kind: 'automation', target_id: '', outcome: 'minimal' },
            'junk',
        ]);
        await expect(listAiActAssessments()).resolves.toEqual([
            { kind: 'agent', id: '7', title: 'Helpdesk', outcome: 'minimal', attestedAt: '2026-09-01', expiresAt: null, current: true },
        ]);
        expect(api.get).toHaveBeenCalledWith('/api/compliance/ai-act/assessments');
        const src = fs.readFileSync(path.join(SERVER, 'routes/compliance/aiAct.js'), 'utf8');
        for (const key of ["router.get('/ai-act/assessments',", 'target_kind: r.target_kind', 'target_id: r.target_id', 'expires_at: r.expires_at || null', 'current: aiActAssessmentStore.isCurrent(r)']) {
            expect(src).toContain(key);
        }
    });

    it('reads the live signals for an agent, null on a 404', async () => {
        (api.get as jest.Mock).mockResolvedValueOnce({ marking_enabled: true });
        await expect(getAiActSignals('agent', 'g1')).resolves.toMatchObject({ markingEnabled: true });
        expect(api.get).toHaveBeenCalledWith('/api/compliance/ai-act/assessments/agent/g1/signals');
        (api.get as jest.Mock).mockRejectedValueOnce(new ApiError('Not found', { status: 404 }));
        await expect(getAiActSignals('agent', 'g1')).resolves.toBeNull();
    });

    it('switches marking on with one setting, never retried', async () => {
        (api.put as jest.Mock).mockResolvedValue({});
        await enableMarking();
        expect(api.put).toHaveBeenCalledWith('/api/compliance/settings', { ai_content_marking_enabled: true }, { retry: false });
        expect(fs.readFileSync(path.join(SERVER, 'routes/compliance/settings.js'), 'utf8')).toContain('ai_content_marking_enabled');
    });
});
