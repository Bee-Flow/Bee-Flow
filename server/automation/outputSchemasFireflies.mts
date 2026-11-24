/**
 * Output schemas of the Fireflies tools (integrations/firefliesTools.js), merged into OUTPUT_SCHEMAS by
 * ./outputSchemas.js: what the builder and the Cowork planner may bind to, checked against the executors' return
 * values; change both together.
 *
 * Without them a plan had nothing to read a Fireflies output from but the tool's description, and one bound
 * `steps.<list>.output.transcripts` (the GraphQL field name inside the tool): the list is `results`. With a curated
 * shape the builder refuses that path when it is added, and Cowork refuses it before a plan is approved
 * (core/cowork/plan/planRefs.mts).
 */

const TRANSCRIPT = '{ id, title, date, duration, organizer, participants (array of string), speakers (array of string), url }';

const sampleTranscript = {
    id: 'sample-transcript', title: 'Weekly sync', date: '2026-11-17T10:00:00.000Z', duration: '45m',
    organizer: 'organizer@example.com', participants: ['organizer@example.com'], speakers: ['Organizer'], url: 'https://app.fireflies.ai/view/sample-transcript',
};

export const OUTPUT_SCHEMAS_FIREFLIES: Record<string, { shape: Record<string, string>; sample: unknown }> = {
    fireflies_list_transcripts: {
        shape: {
            results: `array of ${TRANSCRIPT}`,
            count: 'integer (how many are in results)',
            message: 'string',
            matchQuality: 'string (exact|partial|none; only when a title was asked)',
            exactMatches: `array of ${TRANSCRIPT} (only when a title was asked)`,
            scannedTitles: 'array of string (only when no title matched)',
        },
        sample: { results: [sampleTranscript], count: 1, message: 'Found 1 transcript(s).' },
    },
    fireflies_get_summary: {
        shape: {
            id: 'string', title: 'string', date: 'string', duration: 'string', organizer: 'string',
            participants: 'array of string', speakers: 'array of string', url: 'string',
            summary: 'object { keywords, action_items, outline, shorthand_bullet, overview, bullet_gist, gist, short_summary }',
            analytics: 'object',
        },
        sample: { ...sampleTranscript, summary: { overview: 'A short overview of the meeting.', action_items: 'Send the notes.' }, analytics: {} },
    },
    fireflies_get_transcript: {
        shape: {
            id: 'string', title: 'string', date: 'string', duration: 'string', speakers: 'array of string',
            sentenceCount: 'integer', truncated: 'boolean', sentences: 'array of { speaker, text, time }',
        },
        sample: { id: 'sample-transcript', title: 'Weekly sync', date: '2026-11-17T10:00:00.000Z', duration: '45m', speakers: ['Organizer'], sentenceCount: 1, truncated: false, sentences: [{ speaker: 'Organizer', text: 'Hello.', time: '0:01' }] },
    },
};
