/**
 * Fixtures for the Meeting notes demo.
 *
 * One finished meeting, written out the way the product stores it: diarised
 * segments, named speakers, a summary, decisions, questions and action items
 * with timestamps. That is enough for the library, the transcript view, the
 * insights tabs and the speaker legend to render their real layouts.
 *
 * There is deliberately NO audio. `audioStorageKey` is null, so the player
 * takes the same "recording is no longer available" path a real note takes
 * once its audio has been cleaned up — a real state of the product, rather
 * than a broken one. It also means the demo never streams media, never
 * records anything and never asks for a microphone.
 *
 * The transcript is invented. No real meeting, person or company appears.
 */

import { COMMON_ROUTES, daysAgo } from './common';

const MEETING_ID = 'tr_demo_platform_review';

/**
 * The speaker's `id` IS its display label — `formatSpeakerLabel(s.id)` is what
 * the legend, the transcript and the player rows render. A meeting that has
 * been through the naming step therefore stores real names as ids, and
 * `Speaker 1` only survives where nobody has named them. Using names here is
 * what makes this look like a finished note rather than a raw transcript.
 */
const SPEAKERS = () => ([
    { id: 'Casey Hayes', name: 'Casey Hayes', color: '#3B82F6' },
    { id: 'Taylor Rivera', name: 'Taylor Rivera', color: '#EC4899' },
    { id: 'Quinn Ellis', name: 'Quinn Ellis', color: '#F59E0B' },
    { id: 'Riley Fox', name: 'Riley Fox', color: '#10B981' },
]);

/**
 * A short but complete conversation. Timestamps are seconds; the transcript
 * view, the speaker rows and the "jump to" links on action items all read
 * from these, so they have to be internally consistent.
 */
const SEGMENTS = () => ([
    { start: 6, end: 21, speaker: 'Casey Hayes', text: 'Right — the point of today is to decide whether we roll the new intake flow out to the whole team next sprint, or keep it with the pilot group for another two weeks.' },
    { start: 22, end: 44, speaker: 'Taylor Rivera', text: 'From my side the pilot has gone well. Fourteen people used it last week, and the only complaint was that the confirmation step was easy to miss on mobile.' },
    { start: 45, end: 58, speaker: 'Quinn Ellis', text: 'That matches what I heard. Nobody asked to go back to the old form, which is the bit I care about.' },
    { start: 59, end: 92, speaker: 'Riley Fox', text: 'The thing I would want before a wide rollout is the audit trail. At the moment we log that a document was filed, but not who approved it. If we go org-wide and someone asks in three months, we cannot answer.' },
    { start: 93, end: 118, speaker: 'Casey Hayes', text: 'How much work is that, realistically?' },
    { start: 119, end: 151, speaker: 'Riley Fox', text: 'A day, maybe a day and a half. The approval step already carries the user; it just is not written to the run log. I would rather do it before rollout than after.' },
    { start: 152, end: 176, speaker: 'Taylor Rivera', text: 'Then let us do that. It is one sprint item, and it removes the only objection I would expect from legal.' },
    { start: 177, end: 205, speaker: 'Casey Hayes', text: 'Agreed. So: Riley adds the approver to the audit log this sprint, and we roll out to everyone the sprint after. Taylor, can you fix the mobile confirmation step at the same time?' },
    { start: 206, end: 218, speaker: 'Taylor Rivera', text: 'Yes. It is a layout fix, not a logic one — half a day.' },
    { start: 219, end: 244, speaker: 'Quinn Ellis', text: 'One more thing. Do we tell the pilot group they are staying on it for another two weeks? They were told it was two weeks total, and we are now at four.' },
    { start: 245, end: 268, speaker: 'Casey Hayes', text: 'Fair. I will send a note today explaining why and what changes. Anything else before we close?' },
    { start: 269, end: 279, speaker: 'Riley Fox', text: 'Nothing from me.' },
    { start: 280, end: 291, speaker: 'Casey Hayes', text: 'Good. Thanks everyone.' },
]);

/** The plain transcript, rebuilt from segments so it follows every rename. */
const transcriptOf = (segments: Array<{ speaker: string; text: string }>) => segments
    .map(s => `${s.speaker}: ${s.text}`)
    .join('\n\n');

const FULL_TEXT = () => transcriptOf(SEGMENTS());

const SUMMARY = `**Decision:** the new intake flow goes org-wide the sprint after next, once the approval audit trail is in place.

**Where the pilot landed**
- Fourteen people used it last week; nobody asked to return to the old form.
- The one usability complaint was the confirmation step being easy to miss on mobile.

**What is blocking a wider rollout**
- The run log records that a document was filed, but not who approved it. Riley estimated a day to a day and a half to add the approver, and the team agreed to do it before rollout rather than after — mainly to pre-empt a legal question later.

**Also agreed**
- Taylor fixes the mobile confirmation layout in the same sprint (about half a day).
- Casey writes to the pilot group today: the pilot was announced as two weeks and is now at four, so they get an explanation and a note of what changes.`;

const ACTION_ITEMS = () => ([
    { id: 'ai_1', text: 'Add the approving user to the automation run log', assignee: 'Riley Fox', timestamp: 151, done: false },
    { id: 'ai_2', text: 'Fix the confirmation step layout on mobile', assignee: 'Taylor Rivera', timestamp: 218, done: false },
    { id: 'ai_3', text: 'Write to the pilot group explaining the extension and what changes', assignee: 'Casey Hayes', timestamp: 268, done: false },
]);

const DECISIONS = () => ([
    { id: 'dec_1', text: 'Roll the intake flow out org-wide the sprint after next, not next sprint.', timestamp: 205 },
    { id: 'dec_2', text: 'The approval audit trail ships before the wide rollout, not after it.', timestamp: 176 },
]);

const QUESTIONS = () => ([
    { id: 'q_1', text: 'Does the pilot group need to be told the pilot is being extended?', timestamp: 244, answered: true },
]);

const CHAPTERS = () => ([
    { title: 'Purpose of the meeting', start: 6, end: 22 },
    { title: 'How the pilot went', start: 22, end: 59 },
    { title: 'The audit-trail gap', start: 59, end: 152 },
    { title: 'Decision and owners', start: 152, end: 219 },
    { title: 'Communicating with the pilot group', start: 219, end: 291 },
]);

type Speaker = ReturnType<typeof SPEAKERS>[number];
type Segment = ReturnType<typeof SEGMENTS>[number];

interface Detail {
    id: string;
    title: string;
    fileName: string;
    language: string;
    durationSeconds: number;
    speakerCount: number;
    numSpeakers: number;
    segmentCount: number;
    status: string;
    provider: string;
    source: string;
    talkRoomToken: string | null;
    meetMeetingCode: string | null;
    isPublished: boolean;
    sharedGroups: string[];
    sharedWith: string[];
    tags: string[];
    organizationId: string;
    createdAt: string;
    updatedAt: string;
    isOwner: boolean;
    ownerId: string;
    fullText: string;
    transcript: string;
    summary: string;
    segments: Segment[];
    speakers: Speaker[];
    attendees: string[];
    actionItems: ReturnType<typeof ACTION_ITEMS>;
    decisions: ReturnType<typeof DECISIONS>;
    questions: ReturnType<typeof QUESTIONS>;
    chapters: ReturnType<typeof CHAPTERS>;
    voiceprintMatches: string[];
    audioPath: string;
    audioStorageKey: string | null;
    sourceUri: string | null;
}

function detail(): Detail {
    return {
        id: MEETING_ID,
        title: 'Intake flow — pilot review',
        fileName: 'intake-flow-pilot-review.m4a',
        language: 'en',
        durationSeconds: 291,
        speakerCount: 4,
        numSpeakers: 4,
        segmentCount: SEGMENTS().length,
        status: 'completed',
        provider: 'voxtral',
        source: 'upload',
        talkRoomToken: null,
        meetMeetingCode: null,
        isPublished: false,
        sharedGroups: [],
        sharedWith: [],
        tags: ['product', 'rollout'],
        organizationId: 'demo-org',
        createdAt: daysAgo(2),
        updatedAt: daysAgo(2),
        isOwner: true,
        ownerId: 'demo-user',
        fullText: FULL_TEXT(),
        transcript: FULL_TEXT(),
        summary: SUMMARY,
        segments: SEGMENTS(),
        speakers: SPEAKERS(),
        attendees: ['Casey Hayes', 'Taylor Rivera', 'Quinn Ellis', 'Riley Fox'],
        actionItems: ACTION_ITEMS(),
        decisions: DECISIONS(),
        questions: QUESTIONS(),
        chapters: CHAPTERS(),
        voiceprintMatches: [],
        // No audio in the demo — the player renders its "recording unavailable"
        // state, which is a real state of the product.
        audioPath: '',
        audioStorageKey: null,
        sourceUri: null,
    };
}

/** Two more rows so the library looks like a library rather than one card. */
function siblings(): Detail[] {
    const base = detail();
    return [
        {
            ...base,
            id: 'tr_demo_kickoff',
            title: 'Q3 planning kickoff',
            durationSeconds: 2_713,
            speakerCount: 6,
            numSpeakers: 6,
            segmentCount: 214,
            tags: ['planning'],
            createdAt: daysAgo(9),
            updatedAt: daysAgo(9),
        },
        {
            ...base,
            id: 'tr_demo_vendor',
            title: 'Vendor call — storage renewal',
            durationSeconds: 1_486,
            speakerCount: 3,
            numSpeakers: 3,
            segmentCount: 122,
            tags: ['procurement'],
            createdAt: daysAgo(23),
            updatedAt: daysAgo(23),
        },
    ];
}

/** The list payload is a strict subset of the detail payload. */
function toListItem(t: Detail) {
    return {
        id: t.id, title: t.title, fileName: t.fileName, language: t.language,
        durationSeconds: t.durationSeconds, speakerCount: t.speakerCount,
        segmentCount: t.segmentCount, status: t.status, provider: t.provider,
        source: t.source, talkRoomToken: t.talkRoomToken, meetMeetingCode: t.meetMeetingCode,
        isPublished: t.isPublished, sharedGroups: t.sharedGroups, tags: t.tags,
        organizationId: t.organizationId, createdAt: t.createdAt, updatedAt: t.updatedAt,
        isOwner: true, ownerId: 'demo-user',
        transcriptSnippet: t.fullText.slice(0, 400),
    };
}

type State = { transcriptions: Detail[]; templates: unknown[]; agents: unknown[] };
type SpeakerMerge = { from?: unknown; into?: unknown };
type Ctx = {
    state: State;
    params: Record<string, string>;
    body: ({ renames?: Record<string, unknown>; merges?: SpeakerMerge[]; template?: string; templateId?: string; customPrompt?: string } & Record<string, unknown>) | null;
};

export function createState(): State {
    const all = [detail(), ...siblings()];
    return { transcriptions: all, templates: [], agents: [] };
}

const find = (state: State, id: string) => state.transcriptions.find((t: Detail) => t.id === id) || null;
const notFound = () => new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
const badRequest = (error: string, code: string) => new Response(JSON.stringify({ error, code }), { status: 400, headers: { 'Content-Type': 'application/json' } });

/**
 * The built-in summary templates, in the shape GET /api/summary-templates
 * answers (server/utils/summaryTemplates.js): the regenerate menu lists
 * them and the template editor offers them as a starting point. The prompts
 * are short stand-ins; the demo never sends one to a model.
 */
const BUILTIN_TEMPLATES = [
    { id: 'general', nameKey: 'meeting_notes.template_general', name: 'General meeting', prompt: 'Summarise the meeting: purpose, decisions, action items with owners, open questions.' },
    { id: 'standup', nameKey: 'meeting_notes.template_standup', name: 'Stand-up', prompt: 'Per person: what they did, what they will do next, what blocks them.' },
    { id: 'sales', nameKey: 'meeting_notes.template_sales', name: 'Sales call', prompt: 'The customer\'s needs, objections, budget and timeline, and the agreed next steps.' },
    { id: 'interview', nameKey: 'meeting_notes.template_interview', name: 'Interview', prompt: 'The questions asked, the key answers, strengths, concerns and a recommendation.' },
    { id: 'retrospective', nameKey: 'meeting_notes.template_retrospective', name: 'Retrospective', prompt: 'What went well, what did not, and the improvements the team agreed on.' },
];

/**
 * The speaker edit the real PATCH /:id/speakers performs
 * (server/routes/transcriptions/speakers.js), on the in-memory note:
 * merges first, then renames, both keyed on the ORIGINAL label and applied
 * as one substitution. The label IS the speaker id (see SPEAKERS), so the
 * segments, the speaker rows, the transcript text and the action-item
 * assignees all move together. Answers the whole note, as the server does,
 * or a 400 when two speakers would end up with one name.
 */
function editSpeakers(t: Detail, body: Ctx['body']): Detail | Response {
    const { mergeOf, remap } = speakerRemap(body);
    const collision = speakerCollision(t.speakers, mergeOf, remap);
    if (collision) return badRequest(collision, 'speaker_name_collision');
    return relabel(t, remap);
}

/** One simultaneous substitution over the ORIGINAL labels, never a chain. */
function speakerRemap(body: Ctx['body']) {
    const mergeOf = mergeTargets(body?.merges || []);
    const renameOf = new Map<string, string>();
    for (const [oldName, newName] of Object.entries(body?.renames || {})) {
        if (typeof newName === 'string' && newName.trim()) renameOf.set(oldName, newName.trim());
    }
    const remap = (name: string) => {
        const merged = mergeOf.get(name) ?? name;
        return renameOf.get(name) ?? renameOf.get(merged) ?? merged;
    };
    return { mergeOf, remap };
}

/** Each merged-away label and the label it folds into. */
function mergeTargets(merges: SpeakerMerge[]) {
    const mergeOf = new Map<string, string>();
    for (const merge of merges) {
        const into = typeof merge?.into === 'string' ? merge.into.trim() : '';
        const from = Array.isArray(merge?.from) ? merge.from : [];
        for (const name of from) if (into && typeof name === 'string' && name.trim()) mergeOf.set(name, into);
    }
    return mergeOf;
}

/** The refusal when two surviving speakers would end up with one name, or null. */
function speakerCollision(speakers: Speaker[], mergeOf: Map<string, string>, remap: (name: string) => string) {
    const survivors = new Map<string, string>();
    for (const s of speakers) {
        if (mergeOf.has(s.id)) continue;
        const to = remap(s.id);
        const taken = survivors.get(to);
        if (taken && taken !== s.id) {
            return `"${taken}" and "${s.id}" would both become "${to}". Rename them to different names, or merge them explicitly.`;
        }
        survivors.set(to, s.id);
    }
    return null;
}

/** Move every place that names a speaker to its new label. */
function relabel(t: Detail, remap: (name: string) => string): Detail {
    const speakers: Speaker[] = [];
    for (const s of t.speakers) {
        const id = remap(s.id);
        if (!speakers.some(x => x.id === id)) speakers.push({ ...s, id, name: id });
    }
    t.speakers = speakers;
    t.segments = t.segments.map(seg => ({ ...seg, speaker: remap(seg.speaker) }));
    t.actionItems = t.actionItems.map(ai => (ai.assignee ? { ...ai, assignee: remap(ai.assignee) } : ai));
    t.attendees = t.attendees.map(remap).filter((name, i, all) => all.indexOf(name) === i);
    t.fullText = transcriptOf(t.segments);
    t.transcript = t.fullText;
    t.speakerCount = speakers.length;
    t.numSpeakers = speakers.length;
    return t;
}

/** The stamp the real route writes: which template wrote the summary. */
function regenerateStamp(body: Ctx['body']) {
    if (body?.templateId || (typeof body?.customPrompt === 'string' && body.customPrompt.trim())) {
        return { summaryTemplateId: null, summaryTemplateVersion: null };
    }
    const key = BUILTIN_TEMPLATES.some(b => b.id === body?.template) ? body?.template : 'general';
    return { summaryTemplateId: `builtin:${key}`, summaryTemplateVersion: null };
}

export const ROUTES = {
    ...COMMON_ROUTES,

    'GET /api/transcriptions': ({ state }: Ctx) => ({
        transcriptions: state.transcriptions.map(toListItem),
        total: state.transcriptions.length,
    }),
    'GET /api/transcriptions/:id': ({ state, params }: Ctx) => find(state, params.id) || notFound(),
    'PATCH /api/transcriptions/:id': ({ state, params, body }: Ctx) => {
        const t = find(state, params.id);
        if (!t) return notFound();
        Object.assign(t, body || {});
        return { success: true, transcription: t };
    },
    'DELETE /api/transcriptions/:id': ({ state, params }: Ctx) => {
        state.transcriptions = state.transcriptions.filter((t: Detail) => t.id !== params.id);
        return { success: true };
    },

    // Speaker renames land in memory so the transcript really does re-label.
    // Same method, path and answer (the whole note) as the real route.
    'PATCH /api/transcriptions/:id/speakers': ({ state, params, body }: Ctx) => {
        const t = find(state, params.id);
        if (!t) return notFound();
        return editSpeakers(t, body);
    },
    // Auto-detect in the speaker editor. Every demo speaker already carries
    // its real name, so a re-run of the naming step lands on the same names.
    'POST /api/transcriptions/:id/reidentify-speakers': ({ state, params }: Ctx) => find(state, params.id) || notFound(),

    // Regeneration is scripted — no model is called, and we say so. The
    // answer has the real route's shape, so the screen merges it the same way.
    'POST /api/transcriptions/:id/regenerate-summary': ({ state, params, body }: Ctx) => {
        const t = find(state, params.id);
        if (!t) return notFound();
        // There are no saved templates in the demo, so a template id is
        // unknown here: the real route's answer for that.
        if (body?.templateId) return new Response(JSON.stringify({ error: 'Template not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        return {
            success: true,
            summary: t.summary,
            actionItems: t.actionItems,
            decisions: t.decisions,
            questions: t.questions,
            artifactsRegenerated: true,
            chapters: t.chapters,
            speakers: t.speakers,
            ...regenerateStamp(body),
            demo: true,
        };
    },

    // Sources the library offers to import from. Empty in the demo: there is
    // no connected account, and the panels render their real empty states.
    'GET /api/transcriptions/talk-meetings': () => ({ meetings: [] }),
    'GET /api/transcriptions/gmeet-meetings': () => ({ meetings: [] }),
    'GET /api/transcriptions/gmeet-recordings': () => ({ recordings: [] }),
    'GET /api/transcriptions/gmeet-imports': () => ({ imports: [] }),
    'GET /api/transcriptions/nextcloud-audio-files': () => ({ files: [] }),
    'GET /api/transcriptions/nextcloud-talk-recordings': () => ({ recordings: [] }),

    // No audio in the demo — answer 404 deliberately so the player takes its
    // real "recording is no longer available" path instead of hanging on a
    // request that was simply never fixtured.
    'GET /api/transcriptions/:id/audio': () => new Response(
        JSON.stringify({ error: 'No recording in the demo' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
    ),

    // "Used by" — the header badge and tab MeetingDetail mounts with
    // (Builder redesign Track 0.4, shared/UsedByTab contract). The real
    // endpoint lands with M2; the demo answers it now, the same way
    // knowledge.js answered its /:id/usage ahead of K5 — unfixtured it is a
    // silent 404 the badge renders as an error state. Only the featured
    // meeting is used by anything: its decisions feed a knowledge base
    // (K7: meeting notes as a KB source), so an assistant can cite them.
    // The demo mounts with no navigation, so neither id needs a page.
    'GET /api/transcriptions/:id/usage': ({ state, params }: Ctx) => {
        if (!find(state, params.id)) return notFound();
        if (params.id !== MEETING_ID) return { usage: [] };
        return {
            usage: [
                { kind: 'kb', id: 'kb_demo_productdocs', title: 'Product documentation', role: 'contains', siteLabel: 'as knowledge', lastAt: daysAgo(1), ownerId: null },
                { kind: 'notebook', id: 'nb_demo_intake', title: 'Intake flow rollout', role: 'read', lastAt: daysAgo(1), ownerId: 'demo-user' },
            ],
        };
    },

    // The shapes of server/routes/summaryTemplates.js. No saved templates in
    // the demo: the built-ins only.
    'GET /api/summary-templates': ({ state }: Ctx) => ({
        builtins: BUILTIN_TEMPLATES,
        custom: state.templates,
        defaultTemplateId: null,
        canManageOrg: false,
        primaryOrgId: 'demo-org',
    }),
    'GET /api/summary-templates/org': ({ state }: Ctx) => ({ orgId: 'demo-org', templates: state.templates, groups: [] }),
    'GET /api/talk-notes-settings/user/me': () => ({ enabled: false }),
    'GET /api/gmeet-notes-settings/user/me': () => ({ enabled: false }),
    'GET /api/teams-notes-settings/user/me': () => ({ enabled: false }),
    'GET /api/org/users': () => ({ users: [] }),
    'GET /api/org/groups': () => ({ groups: [] }),
};
