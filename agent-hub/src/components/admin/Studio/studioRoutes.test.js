import { describe, it, expect, afterEach } from 'vitest';
import { STUDIO_APPS } from './studioApps';
import { SEG_TO_SECTION, SECTION_TO_SEG, sectionFromRaw, segmentForSection, parseStudioUrl, parseStudioQuery, buildStudioSearch, parseAppRefParam, appRefParam, stickyFrom } from './studioRoutes';
import { __setRuntimeDescriptorsForTests, __resetRuntimeForTests } from '../../../moduleRuntime/registry';

describe('seg ↔ section maps', () => {
    it('maps every canonical urlSegment and every section id to its section', () => {
        for (const app of STUDIO_APPS) {
            expect(sectionFromRaw(app.urlSegment)).toBe(app.id);
            // Section ids double as accepted raw segments (navigation code
            // historically passed e.g. 'studio/meetingNotes').
            expect(sectionFromRaw(app.id)).toBe(app.id);
            expect(segmentForSection(app.id)).toBe(app.urlSegment);
            expect(SECTION_TO_SEG[app.id]).toBe(app.urlSegment);
        }
    });

    it('accepts every legacy alias from the pre-registry switches', () => {
        // Verbatim truth table of the old App.jsx seg→section switches.
        // 'automations' was the canonical slug until the tab was renamed after
        // the one thing it holds; both it and the older 'ai-tasks' still parse.
        expect(sectionFromRaw('automations')).toBe('aiTasks');
        expect(sectionFromRaw('automations')).toBe('aiTasks');
        expect(sectionFromRaw('ai-tasks')).toBe('aiTasks');
        expect(sectionFromRaw('skills')).toBe('skills');
        expect(sectionFromRaw('knowledge')).toBe('knowledge');
        expect(sectionFromRaw('webpages')).toBe('webpages');
        expect(sectionFromRaw('meeting-notes')).toBe('meetingNotes');
        expect(sectionFromRaw('meetingNotes')).toBe('meetingNotes');
        expect(SEG_TO_SECTION['ai-tasks']).toBe('aiTasks');
        expect(SEG_TO_SECTION['automations']).toBe('aiTasks');
    });

    it('falls back to agents for unknown raw segments', () => {
        expect(sectionFromRaw('nope')).toBe('agents');
    });

    it('resolves NO segment to start, which is a different absence from an unknown one (H1)', () => {
        // /app/studio with nothing after it asks for Studio's front door.
        // /app/studio/nope asked for something specific that no longer
        // exists, and must not be answered with "here is the front door" —
        // it lands on Agents, as it always did (see the test above).
        expect(sectionFromRaw('')).toBe('start');
        expect(sectionFromRaw(undefined)).toBe('start');
        expect(sectionFromRaw('start')).toBe('start');
        expect(segmentForSection('start')).toBe('start');
        expect(SEG_TO_SECTION.start).toBe('start');
        expect(SECTION_TO_SEG.start).toBe('start');
    });

    it('maps sections back to the canonical path segments', () => {
        expect(segmentForSection('aiTasks')).toBe('automations');
        expect(segmentForSection('meetingNotes')).toBe('meeting-notes');
        expect(segmentForSection('agents')).toBe('agents');
    });
});

describe('parseStudioUrl', () => {
    it('parses the bare studio path to start (H1 — was agents)', () => {
        // ROUTE CHANGE, landed in one commit with the rail that gives Start a
        // row and the shell branch that renders it. The page key of
        // /app/studio is untouched — appRoutes.test.js pins that it stays
        // 'studio' — so nothing minted, bookmarked or frozen moves; what
        // changed is only which SECTION the shell opens inside Studio.
        expect(parseStudioUrl('/app/studio')).toEqual({ section: 'start', id: null, sub: null, subId: null, automationKind: null });
        expect(parseStudioUrl('/app/studio/')).toEqual({ section: 'start', id: null, sub: null, subId: null, automationKind: null });
        expect(parseStudioUrl('/app/studio/start')).toEqual({ section: 'start', id: null, sub: null, subId: null, automationKind: null });
    });

    it('parses a plain section with id and flowlet sub-segment', () => {
        expect(parseStudioUrl('/app/studio/automations/abc/flow1'))
            .toEqual({ section: 'aiTasks', id: 'abc', sub: 'flow1', subId: null, automationKind: null });
        expect(parseStudioUrl('/app/studio/skills/skill-1'))
            .toEqual({ section: 'skills', id: 'skill-1', sub: null, subId: null, automationKind: null });
        expect(parseStudioUrl('/app/studio/knowledge'))
            .toEqual({ section: 'knowledge', id: null, sub: null, subId: null, automationKind: null });
        // Knowledge's own four-segment shape: which base, which tab, which
        // source. "These two files were skipped" has to be a link.
        expect(parseStudioUrl('/app/studio/knowledge/kb1'))
            .toEqual({ section: 'knowledge', id: 'kb1', sub: null, subId: null, automationKind: null });
        expect(parseStudioUrl('/app/studio/knowledge/kb1/usage'))
            .toEqual({ section: 'knowledge', id: 'kb1', sub: 'usage', subId: null, automationKind: null });
        expect(parseStudioUrl('/app/studio/knowledge/kb1/sources/src9'))
            .toEqual({ section: 'knowledge', id: 'kb1', sub: 'sources', subId: 'src9', automationKind: null });
    });

    it('treats the reserved "steps" segment as automationKind=step, on every slug', () => {
        expect(parseStudioUrl('/app/studio/automations/steps/abc'))
            .toEqual({ section: 'aiTasks', id: 'abc', sub: null, subId: null, automationKind: 'step' });
        expect(parseStudioUrl('/app/studio/automations/steps/abc'))
            .toEqual({ section: 'aiTasks', id: 'abc', sub: null, subId: null, automationKind: 'step' });
        expect(parseStudioUrl('/app/studio/automations/steps/abc/flow1'))
            .toEqual({ section: 'aiTasks', id: 'abc', sub: 'flow1', subId: null, automationKind: 'step' });
        // The reserved "steps" branch shifts every segment one along, so a
        // reusable step's flowlet must stay in `sub` now that a fourth
        // segment exists beside it.
        expect(parseStudioUrl('/app/studio/automations/steps/abc/flow1/extra'))
            .toEqual({ section: 'aiTasks', id: 'abc', sub: 'flow1', subId: 'extra', automationKind: 'step' });
        // Legacy ai-tasks slug keeps the same special case.
        expect(parseStudioUrl('/app/studio/ai-tasks/steps/xyz'))
            .toEqual({ section: 'aiTasks', id: 'xyz', sub: null, subId: null, automationKind: 'step' });
    });

    it('keeps legacy ai-tasks URLs working', () => {
        expect(parseStudioUrl('/app/studio/ai-tasks/task-9'))
            .toEqual({ section: 'aiTasks', id: 'task-9', sub: null, subId: null, automationKind: null });
    });

    it('routes legacy /app/webpages paths into the Webpages section', () => {
        expect(parseStudioUrl('/app/webpages')).toEqual({ section: 'webpages', id: null, sub: null, subId: null, automationKind: null });
        expect(parseStudioUrl('/app/webpages/w1')).toEqual({ section: 'webpages', id: 'w1', sub: null, subId: null, automationKind: null });
    });

    it('routes legacy /app/meeting-notes paths into the Meeting Notes section', () => {
        expect(parseStudioUrl('/app/meeting-notes')).toEqual({ section: 'meetingNotes', id: null, sub: null, subId: null, automationKind: null });
        expect(parseStudioUrl('/app/meeting-notes/m1')).toEqual({ section: 'meetingNotes', id: 'm1', sub: null, subId: null, automationKind: null });
    });

    it('routes legacy /app/notebooks paths into Documents, onto the notebook', () => {
        expect(parseStudioUrl('/app/notebooks')).toEqual({ section: 'documents', id: null, sub: null, subId: null, automationKind: null });
        expect(parseStudioUrl('/app/notebooks/nb1')).toEqual({ section: 'documents', id: 'notebook', sub: 'nb1', subId: null, automationKind: null });
        // The canonical address of a notebook is the same route.
        expect(parseStudioUrl('/app/studio/documents/notebook/nb1')).toMatchObject({ section: 'documents', id: 'notebook', sub: 'nb1' });
    });

    it('parses the remaining studio sections', () => {
        expect(parseStudioUrl('/app/studio/approvals').section).toBe('approvals');
        expect(parseStudioUrl('/app/studio/meeting-notes').section).toBe('meetingNotes');
        expect(parseStudioUrl('/app/studio/webpages/w2'))
            .toEqual({ section: 'webpages', id: 'w2', sub: null, subId: null, automationKind: null });
        expect(parseStudioUrl('/app/studio/playbooks/pb_1'))
            .toEqual({ section: 'playbooks', id: 'pb_1', sub: null, subId: null, automationKind: null });
        expect(parseStudioUrl('/app/studio/playbooks/new').id).toBe('new');
    });

    it('falls back to agents for unknown sections', () => {
        expect(parseStudioUrl('/app/studio/unknown-thing'))
            .toEqual({ section: 'agents', id: null, sub: null, subId: null, automationKind: null });
        // 'support' is a retired section, so it is an unknown segment now —
        // an old bookmark lands on Agents rather than on a blank shell.
        expect(sectionFromRaw('support')).toBe('agents');
        expect(parseStudioUrl('/app/studio/support').section).toBe('agents');
    });
});

describe('the Runs & log section addresses a run by query, not by path (H2)', () => {
    it('resolves /app/studio/runs and carries ?run=/?step= alongside it', () => {
        expect(sectionFromRaw('runs')).toBe('runs');
        expect(segmentForSection('runs')).toBe('runs');
        expect(parseStudioUrl('/app/studio/runs')).toEqual({ section: 'runs', id: null, sub: null, subId: null, automationKind: null });
        // The run itself lives in the query string, the way the builder's
        // history tab already addresses one — so a link to one run in the log
        // is the section's own URL plus ?run=.
        expect(parseStudioQuery('?run=r7&step=s2')).toEqual({ view: null, runId: 'r7', stepId: 's2', from: null });
    });

    it('a stray path segment after /runs is not a run id', () => {
        // The section has no /:id route: parseStudioUrl still fills `id`
        // positionally, and AgentHub deliberately does not read it for this
        // section. Pinned so that a later "let's deep-link by path" change has
        // to change this test and read the note above it.
        expect(parseStudioUrl('/app/studio/runs/r7').section).toBe('runs');
    });
});

describe('runtime (remote-module) segment extension', () => {
    afterEach(() => __resetRuntimeForTests());

    it('resolves a remote module segment once its descriptor is registered', () => {
        // Before registration the segment is unknown → agents fallback.
        expect(sectionFromRaw('uptime')).toBe('agents');
        expect(parseStudioUrl('/app/studio/uptime').section).toBe('agents');

        __setRuntimeDescriptorsForTests([
            { id: 'uptime_monitor', urlSegment: 'uptime', legacySegments: [] },
        ]);

        expect(sectionFromRaw('uptime')).toBe('uptime_monitor');
        expect(sectionFromRaw('uptime_monitor')).toBe('uptime_monitor');
        expect(segmentForSection('uptime_monitor')).toBe('uptime');
        expect(parseStudioUrl('/app/studio/uptime'))
            .toEqual({ section: 'uptime_monitor', id: null, sub: null, subId: null, automationKind: null });
    });

    it('never lets a remote module shadow a built-in segment', () => {
        __setRuntimeDescriptorsForTests([
            { id: 'evil', urlSegment: 'agents', legacySegments: ['skills'] },
        ]);
        expect(sectionFromRaw('agents')).toBe('agents');
        expect(sectionFromRaw('skills')).toBe('skills');
        expect(segmentForSection('agents')).toBe('agents');
    });
});

describe('parseStudioQuery / buildStudioSearch', () => {
    it('round-trips the builder state', () => {
        const state = { view: 'runs', runId: 'run_123', stepId: 'act_9', from: null };
        expect(parseStudioQuery(buildStudioSearch(state))).toEqual(state);
    });

    it('omits nulls, and omits the default Editor view entirely', () => {
        expect(buildStudioSearch({})).toBe('');
        expect(buildStudioSearch({ view: 'build' })).toBe('');
        expect(buildStudioSearch({ view: 'build', runId: 'r1' })).toBe('?run=r1');
        expect(buildStudioSearch({ view: 'settings' })).toBe('?view=settings');
    });

    it('parses absent state to explicit nulls', () => {
        expect(parseStudioQuery('')).toEqual({ view: null, runId: null, stepId: null, from: null });
        expect(parseStudioQuery('?other=x')).toEqual({ view: null, runId: null, stepId: null, from: null });
        expect(parseStudioQuery('view=runs&run=r2')).toEqual({ view: 'runs', runId: 'r2', stepId: null, from: null });
    });
});

describe('?from= — the button the builder was opened from (P4)', () => {
    const REF = { appId: '5f2a1c34-8b7d-4e19-9f00-2ab3c4d5e6f7', screenId: 'scr_dash01', nodeId: 'cmp_btn123' };
    const TOKEN = 'app:5f2a1c34-8b7d-4e19-9f00-2ab3c4d5e6f7:scr_dash01:cmp_btn123';

    it('survives a rebuild of the query, which is how a view switch works', () => {
        // pushBuilderState rebuilds the whole search string from a state
        // object on every view/run change. Before `from` was part of that
        // shape, the first click in the builder dropped it and the breadcrumb
        // disappeared — a round trip that only went one way.
        const search = buildStudioSearch({ view: 'runs', from: TOKEN });
        expect(search).toBe(`?view=runs&from=${encodeURIComponent(TOKEN)}`);
        expect(parseStudioQuery(search)).toEqual({ view: 'runs', runId: null, stepId: null, from: TOKEN });
    });

    it('round-trips a reference through the token and back', () => {
        expect(appRefParam(REF)).toBe(TOKEN);
        expect(parseAppRefParam(appRefParam(REF))).toEqual(REF);
    });

    it('drops anything that is not exactly one well-formed reference', () => {
        expect(parseAppRefParam(null)).toBeNull();
        expect(parseAppRefParam('')).toBeNull();
        // Unknown kind — a later `from` kind is someone else's to add.
        expect(parseAppRefParam('page:abc:scr_dash01:cmp_btn123')).toBeNull();
        // Wrong arity: half a reference is not a reference.
        expect(parseAppRefParam('app:abc:scr_dash01')).toBeNull();
        expect(parseAppRefParam('app:abc:scr_dash01:cmp_btn123:extra')).toBeNull();
    });

    it('refuses ids that do not look like ids — this string comes from the address bar', () => {
        expect(parseAppRefParam('app:../../etc/passwd:scr_dash01:cmp_btn123')).toBeNull();
        expect(parseAppRefParam('app:abc:dashboard:cmp_btn123')).toBeNull();
        expect(parseAppRefParam('app:abc:scr_dash01:<img src=x>')).toBeNull();
        // …and the builder never mints one either.
        expect(appRefParam({ appId: 'abc', screenId: 'scr_dash01', nodeId: '' })).toBeNull();
        expect(appRefParam({ appId: 'abc', screenId: 'scr_dash01' })).toBeNull();
        expect(appRefParam(null)).toBeNull();
    });

    it('omits `from` when there is none, so plain automation URLs are untouched', () => {
        expect(buildStudioSearch({ from: null })).toBe('');
        expect(buildStudioSearch({ view: 'build', from: null })).toBe('');
    });
});

describe('stickyFrom — which automation a `from` token belongs to', () => {
    const T = 'app:app-1:scr_dash01:cmp_btn123';

    it('keeps the token while the same automation stays open', () => {
        const prev = { automationId: 'aut_1', token: T };
        // Same object back, so a caller can `!==`-check.
        expect(stickyFrom(prev, 'aut_1')).toBe(prev);
        expect(stickyFrom(prev, null)).toBe(prev);
    });

    it('adopts the automation a brand-new builder is given', () => {
        // Made from the app: the link was about this automation, it just did not
        // have an id yet when the builder opened.
        expect(stickyFrom({ automationId: null, token: T }, 'aut_new')).toEqual({ automationId: 'aut_new', token: T });
    });

    it('DROPS the token when a different automation opens', () => {
        // The flyout keeps this component mounted. Carrying the trail across
        // would claim the next automation was made from a button it has never
        // heard of.
        expect(stickyFrom({ automationId: 'aut_1', token: T }, 'aut_2')).toEqual({ automationId: 'aut_2', token: null });
    });

    it('never invents a token where there was none', () => {
        const none = { automationId: 'aut_1', token: null };
        expect(stickyFrom(none, 'aut_2')).toBe(none);
        expect(stickyFrom(null, 'aut_2')).toBeNull();
    });
});
