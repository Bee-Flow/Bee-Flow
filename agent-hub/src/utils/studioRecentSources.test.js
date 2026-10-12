// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
    STUDIO_RECENT_SOURCES,
    normaliseRecentItems,
    normaliseRecentRows,
    clampDescription,
    firstProse,
    recentStatusOf,
    RECENT_STATUS,
} from './studioRecentSources';

/**
 * The nine Studio list endpoints do not agree with each other — bare arrays vs
 * envelopes, snake_case raw rows vs camelCase mappers, `title` vs `name`.
 * Each adapter is pinned against a payload in the shape its endpoint
 * actually returns, because getting one field name wrong shows up as a silently
 * empty menu, not as an error.
 */

describe('per-section adapters', () => {
    it('agents — a bare array of raw snake_case rows', () => {
        expect(normaliseRecentItems('agents', [
            { id: 'a1', name: 'Sales assistent', description: 'Helps with quotes', updated_at: '2026-08-01T10:00:00Z' },
        ])).toEqual([
            { id: 'a1', name: 'Sales assistent', description: 'Helps with quotes', updatedAt: '2026-08-01T10:00:00Z' },
        ]);
    });

    /**
     * The Sidebar's own `agents` prop is a DIFFERENT list — its query is
     * `owner_id = you OR 'system'`, so it carries the built-in system agents
     * that Studio → Agents deliberately hides. Using it here put rows in the
     * panel that could not be found in the section they claimed to come from.
     * `/agents/all` is the list AgentStudio itself renders.
     */
    it('agents — reads the same endpoint Studio → Agents does', () => {
        expect(STUDIO_RECENT_SOURCES.agents.url).toBe('/agents/all');
        expect(STUDIO_RECENT_SOURCES.agents.fromProp).toBeUndefined();
    });

    it('skills — a bare array with camelCase fields', () => {
        expect(normaliseRecentItems('skills', [
            { id: 's1', name: 'PDF splitter', description: 'Splits PDFs', updatedAt: '2026-08-02T10:00:00Z' },
        ])).toEqual([
            { id: 's1', name: 'PDF splitter', description: 'Splits PDFs', updatedAt: '2026-08-02T10:00:00Z' },
        ]);
    });

    it('knowledge — a bare array with snake_case timestamps', () => {
        expect(normaliseRecentItems('knowledge', [
            { id: 'k1', name: 'Handboek', description: 'Company handbook', updated_at: '2026-08-03T10:00:00Z' },
        ])).toEqual([
            { id: 'k1', name: 'Handboek', description: 'Company handbook', updatedAt: '2026-08-03T10:00:00Z' },
        ]);
    });

    it('aiTasks — the { automations } envelope, and `title` is the name', () => {
        expect(normaliseRecentItems('aiTasks', {
            automations: [{ id: 'r1', title: 'Offerte-automation', description: 'Builds quotes', updatedAt: '2026-08-04T10:00:00Z' }],
        })).toEqual([
            { id: 'r1', name: 'Offerte-automation', description: 'Builds quotes', updatedAt: '2026-08-04T10:00:00Z' },
        ]);
    });

    it('webpages — prefers the author-written tagline over the SEO description', () => {
        expect(normaliseRecentItems('webpages', {
            webpages: [{ id: 'w1', name: 'Pricing', tagline: 'What it costs', description: 'A long SEO blurb', updatedAt: '2026-08-05T10:00:00Z' }],
        })[0].description).toBe('What it costs');
        // …and falls back to description when there is no tagline.
        expect(normaliseRecentItems('webpages', {
            webpages: [{ id: 'w2', name: 'About', description: 'Who we are', updatedAt: '2026-08-05T10:00:00Z' }],
        })[0].description).toBe('Who we are');
    });

    /**
     * Support's adapter (subject → name, last_message_at → recency) is gone,
     * and deliberately so: the 2026-09 Studio redesign (ad198f2) dropped the
     * whole Studio section — the org-facing inbox people actually use is the
     * Admin dashboard's — and the orphaned source went with it.
     * studioApps.test.jsx pins that `support` is no longer a section at all,
     * so pinning its adapter here was pinning a payload no panel ever fetches.
     * Solutions took the slot in the same commit: /api/projects was the one
     * live built-in section with no recents source.
     */
    it('solutions — a bare array of camelCase project rows', () => {
        expect(normaliseRecentItems('solutions', [
            { id: 'pr1', name: 'Website relaunch', description: 'All the moving parts', updatedAt: '2026-08-06T10:00:00Z' },
        ])).toEqual([
            { id: 'pr1', name: 'Website relaunch', description: 'All the moving parts', updatedAt: '2026-08-06T10:00:00Z' },
        ]);
    });

    it('solutions — tolerates a { projects } envelope and snake_case timestamps', () => {
        expect(normaliseRecentItems('solutions', {
            projects: [{ id: 'pr2', name: 'Intranet', updated_at: '2026-08-07T10:00:00Z' }],
        })[0].updatedAt).toBe('2026-08-07T10:00:00Z');
    });

    it('apps — the { apps } envelope from /mine', () => {
        expect(normaliseRecentItems('apps', {
            apps: [{ id: 'p1', name: 'Order lookup', description: 'Finds orders', updatedAt: '2026-08-07T10:00:00Z' }],
        })).toEqual([
            { id: 'p1', name: 'Order lookup', description: 'Finds orders', updatedAt: '2026-08-07T10:00:00Z' },
        ]);
    });

    it('meetingNotes — title, falling back to the file name', () => {
        expect(normaliseRecentItems('meetingNotes', {
            transcriptions: [
                { id: 'm1', title: 'Standup', updatedAt: '2026-08-08T10:00:00Z' },
                { id: 'm2', fileName: 'recording-12.m4a', updatedAt: '2026-08-09T10:00:00Z' },
            ],
        })).toEqual([
            { id: 'm1', name: 'Standup', description: null, updatedAt: '2026-08-08T10:00:00Z' },
            { id: 'm2', name: 'recording-12.m4a', description: null, updatedAt: '2026-08-09T10:00:00Z' },
        ]);
    });

    it('meetingNotes — describes the meeting from its summary, skipping the heading', () => {
        const summary = '## 📋 Samenvatting\n\nTom en zijn gesprekspartner bespraken de status van de Azure-inrichting.\n\n## 🔑 Belangrijkste onderwerpen\n- Status van app-registraties';
        expect(normaliseRecentItems('meetingNotes', {
            transcriptions: [{ id: 'm1', title: 'Voortgang Azure', summarySnippet: summary, updatedAt: '2026-08-08T10:00:00Z' }],
        })[0].description).toBe('Tom en zijn gesprekspartner bespraken de status van de Azure-inrichting.');
    });
});

describe('normalisation edges', () => {
    it('an unknown section yields nothing rather than throwing', () => {
        expect(normaliseRecentItems('nope', { anything: [] })).toEqual([]);
        expect(normaliseRecentRows('nope', [{ id: 'x' }])).toEqual([]);
    });

    it('a wrong-shaped payload yields nothing — a 200 with an error body is still a miss', () => {
        for (const payload of [null, undefined, {}, { error: 'nope' }, 'a string']) {
            expect(normaliseRecentItems('aiTasks', payload)).toEqual([]);
        }
        // A bare-array section handed an envelope, and vice versa.
        expect(normaliseRecentItems('skills', { skills: [{ id: 's1' }] })).toEqual([]);
        expect(normaliseRecentItems('apps', [{ id: 'p1' }])).toEqual([]);
    });

    it('drops rows with no id — an unkeyed row could only navigate nowhere', () => {
        expect(normaliseRecentItems('skills', [{ name: 'no id' }, { id: 's1', name: 'ok' }]))
            .toHaveLength(1);
    });

    it('every declared section has a url and a mapper', () => {
        for (const [id, source] of Object.entries(STUDIO_RECENT_SOURCES)) {
            expect(typeof source.map, `${id}.map`).toBe('function');
            expect(typeof source.url, `${id}.url`).toBe('string');
        }
    });
});

describe('firstProse', () => {
    it('skips the heading and returns the first real sentence', () => {
        expect(firstProse('## 📋 Samenvatting\n\nTom besprak de inrichting.')).toBe('Tom besprak de inrichting.');
    });

    it('skips bullets, numbered items, quotes, tables and rules', () => {
        expect(firstProse('- one\n1. two\n2) three\n> quoted\n| a | b |\n---\n***\nReal prose here.'))
            .toBe('Real prose here.');
    });

    it('skips a bold-only line, which is a heading in disguise', () => {
        expect(firstProse('**Samenvatting**\nThe actual summary.')).toBe('The actual summary.');
        expect(firstProse('**Samenvatting:**\nThe actual summary.')).toBe('The actual summary.');
    });

    it('keeps a sentence that merely CONTAINS bold, and strips the markers', () => {
        expect(firstProse('The **Azure** rollout is done.')).toBe('The Azure rollout is done.');
    });

    it('flattens links and inline code to their text', () => {
        expect(firstProse('See [the doc](https://x.test) and `run.sh`.')).toBe('See the doc and run.sh.');
    });

    it('returns null for structure-only, empty and non-string input', () => {
        for (const v of ['## Only a heading\n\n- and a bullet', '', '   \n\n  ', null, undefined, 42]) {
            expect(firstProse(v)).toBeNull();
        }
    });
});

describe('clampDescription', () => {
    it('leaves a short description alone', () => {
        expect(clampDescription('Helps with quotes')).toBe('Helps with quotes');
    });

    it('collapses newlines and runs of whitespace — a menu row is one line of text', () => {
        expect(clampDescription('  Hey there!\n\nI am your   expert.  ')).toBe('Hey there! I am your expert.');
    });

    it('truncates a long description at a word boundary, with an ellipsis', () => {
        const long = 'Hey there! I am your super friendly Nextcloud expert, here to help you with anything and everything about Nextcloud, from setup to troubleshooting.';
        const out = clampDescription(long);
        expect(out.length).toBeLessThanOrEqual(91); // 90 + the ellipsis
        expect(out.endsWith('…')).toBe(true);
        expect(out).not.toMatch(/\s…$/); // no dangling space before the ellipsis
        expect(long.startsWith(out.slice(0, -1))).toBe(true);
    });

    it('still cuts when there is no word boundary to cut on', () => {
        const out = clampDescription('x'.repeat(200));
        expect(out).toBe(`${'x'.repeat(90)}…`);
    });

    it('treats empty, blank and non-string values as no description', () => {
        for (const v of ['', '   ', null, undefined, 42, {}]) expect(clampDescription(v)).toBeNull();
    });
});

/**
 * The status half (Track H3). "Recently edited" on Studio Home puts one word
 * per row, and the only way that word can lie is by being invented — so the
 * three sections that report nothing must answer UNSUPPORTED, and a row whose
 * field is missing must answer UNKNOWN rather than defaulting into a state.
 */
describe('recentStatusOf', () => {
    it('answers UNSUPPORTED for the four sections whose list carries no status', () => {
        // knowledge_bases has no status column; a skill has none; a Solution's
        // health lives on /api/projects/summary, not on its list row; and a
        // datatable's `isPublished` is an AUDIENCE, not a lifecycle — the
        // Tables screen words it "Personal" / "Whole organisation" and never
        // "Draft" (Datatables/DatatableCard.jsx:37-40).
        for (const section of ['knowledge', 'skills', 'solutions', 'datatables']) {
            expect(STUDIO_RECENT_SOURCES[section].status, `${section}.status`).toBeUndefined();
            expect(recentStatusOf(section, { id: 'x', isPublished: true }), section)
                .toBe(RECENT_STATUS.UNSUPPORTED);
        }
    });

    it('an unknown section is UNSUPPORTED, and a non-row is UNKNOWN', () => {
        expect(recentStatusOf('nope', { id: 'x' })).toBe(RECENT_STATUS.UNSUPPORTED);
        expect(recentStatusOf('agents', null)).toBe(RECENT_STATUS.UNKNOWN);
        expect(recentStatusOf('agents', 'not a row')).toBe(RECENT_STATUS.UNKNOWN);
    });

    it('published/draft where the flag really is the lifecycle', () => {
        expect(recentStatusOf('webpages', { isPublished: false })).toBe(RECENT_STATUS.DRAFT);
        expect(recentStatusOf('webpages', { isPublished: true })).toBe(RECENT_STATUS.PUBLISHED);
    });

    it('an agent is LIVE by published_version — not by the OTHER publish verb', () => {
        // is_published is the SHARING flag. Reading it as the lifecycle gives a
        // live personal agent the word "Draft" while its own editor header says
        // LIVE (AgentEditorHeader.test.jsx pins that), and an org-shared draft
        // a green "Published". Wrong in both directions, on the one word the
        // reader has to trust. Raw rows, so both spellings are read.
        expect(recentStatusOf('agents', { published_version: 2, is_published: false }))
            .toBe(RECENT_STATUS.PUBLISHED);
        expect(recentStatusOf('agents', { publishedVersion: 3 })).toBe(RECENT_STATUS.PUBLISHED);
        expect(recentStatusOf('agents', { published_version: 0, is_published: true }))
            .toBe(RECENT_STATUS.DRAFT);
    });

    it('a playbook folds its phases onto the vocabulary: building, paused for you, ready, stopped', () => {
        const pb = (status, phases) => ({ id: 'pb1', title: 'Facturen', status, phases: phases.map((st) => ({ key: 'x', status: st })) });
        expect(recentStatusOf('playbooks', pb('active', ['done', 'running', 'pending']))).toBe(RECENT_STATUS.PROCESSING);
        expect(recentStatusOf('playbooks', pb('active', ['done', 'awaiting', 'pending']))).toBe(RECENT_STATUS.PAUSED);
        expect(recentStatusOf('playbooks', pb('active', ['done', 'failed', 'pending']))).toBe(RECENT_STATUS.FAILED);
        expect(recentStatusOf('playbooks', pb('done', ['done', 'done', 'skipped']))).toBe(RECENT_STATUS.READY);
        expect(recentStatusOf('playbooks', pb('stopped', ['done', 'running']))).toBe(RECENT_STATUS.PAUSED);
        expect(normaliseRecentItems('playbooks', { playbooks: [{ id: 'pb1', title: 'Facturen bijhouden', recipeLabel: 'Invoice tracker', updatedAt: '2026-09-13T10:00:00Z' }] }))
            .toEqual([{ id: 'pb1', name: 'Facturen bijhouden', description: 'Invoice tracker', updatedAt: '2026-09-13T10:00:00Z' }]);
    });

    it('a missing publish flag is UNKNOWN, never "draft"', () => {
        // !!undefined would answer "draft" — a claim about a row we could not
        // read, on the one word the reader is meant to trust.
        expect(recentStatusOf('agents', { id: 'a1' })).toBe(RECENT_STATUS.UNKNOWN);
        expect(recentStatusOf('agents', { id: 'a1', published_version: null })).toBe(RECENT_STATUS.UNKNOWN);
        expect(recentStatusOf('webpages', { id: 'w1', isPublished: null })).toBe(RECENT_STATUS.UNKNOWN);
    });

    it('apps — a published app whose draft has moved on says so', () => {
        expect(recentStatusOf('apps', { isPublished: true, publishedVersion: 3, definitionVersion: 5 }))
            .toBe(RECENT_STATUS.UNPUBLISHED_CHANGES);
        expect(recentStatusOf('apps', { isPublished: true, publishedVersion: 5, definitionVersion: 5 }))
            .toBe(RECENT_STATUS.PUBLISHED);
        expect(recentStatusOf('apps', { isPublished: false, definitionVersion: 5 })).toBe(RECENT_STATUS.DRAFT);
    });

    it('apps — an unknown live version stays PUBLISHED, it is not accused of changes', () => {
        // publishedVersion is NULL on apps published before the column existed.
        // mapAppMetaRow's own note: never read that as "in step with the draft"
        // — and equally never as "ahead of it".
        expect(recentStatusOf('apps', { isPublished: true, publishedVersion: null, definitionVersion: 7 }))
            .toBe(RECENT_STATUS.PUBLISHED);
    });

    it('automations — draft, then a failed last run, then paused/active', () => {
        expect(recentStatusOf('aiTasks', { isDraft: true, isActive: true, lastStatus: 'error' }))
            .toBe(RECENT_STATUS.DRAFT);
        expect(recentStatusOf('aiTasks', { isDraft: false, isActive: true, lastStatus: 'error' }))
            .toBe(RECENT_STATUS.FAILED);
        expect(recentStatusOf('aiTasks', { isDraft: false, isActive: true, lastStatus: 'success' }))
            .toBe(RECENT_STATUS.ACTIVE);
        expect(recentStatusOf('aiTasks', { isDraft: false, isActive: false })).toBe(RECENT_STATUS.PAUSED);
        // Neither true nor false: unknown, not "paused".
        expect(recentStatusOf('aiTasks', { isDraft: false })).toBe(RECENT_STATUS.UNKNOWN);
    });

    it('meeting notes — failed, ready, and anything else is still in flight', () => {
        expect(recentStatusOf('meetingNotes', { status: 'failed' })).toBe(RECENT_STATUS.FAILED);
        expect(recentStatusOf('meetingNotes', { status: 'completed' })).toBe(RECENT_STATUS.READY);
        expect(recentStatusOf('meetingNotes', { status: 'processing' })).toBe(RECENT_STATUS.PROCESSING);
        expect(recentStatusOf('meetingNotes', { status: 'queued' })).toBe(RECENT_STATUS.PROCESSING);
        // Absent from the payload entirely — not the same as 'completed'.
        expect(recentStatusOf('meetingNotes', { id: 'm1' })).toBe(RECENT_STATUS.UNKNOWN);
    });

    it('an accessor that throws or answers outside the vocabulary is UNKNOWN', () => {
        const rogue = { get isPublished() { throw new Error('boom'); } };
        expect(recentStatusOf('agents', rogue)).toBe(RECENT_STATUS.UNKNOWN);
        // "unsupported" is a property of the SECTION and can never be a row's
        // own answer, so an accessor returning it is out of vocabulary.
        const stub = { ...STUDIO_RECENT_SOURCES.agents, status: () => RECENT_STATUS.UNSUPPORTED };
        const original = STUDIO_RECENT_SOURCES.agents;
        STUDIO_RECENT_SOURCES.agents = stub;
        try {
            expect(recentStatusOf('agents', { id: 'a1' })).toBe(RECENT_STATUS.UNKNOWN);
        } finally {
            STUDIO_RECENT_SOURCES.agents = original;
        }
    });

    it('the normalised shape is UNCHANGED — status never leaks into it', () => {
        // The sidebar's panel reads these rows and asserts them exactly; the
        // status is a second question, asked separately from the raw row.
        expect(normaliseRecentItems('agents', [
            { id: 'a1', name: 'Sales', description: 'd', updated_at: '2026-08-01T10:00:00Z', is_published: true },
        ])).toEqual([
            { id: 'a1', name: 'Sales', description: 'd', updatedAt: '2026-08-01T10:00:00Z' },
        ]);
    });
});
