/**
 * The meeting-notes demo's route table, driven through the real transport
 * AND the real client calls (api/transcriptionsApi).
 *
 * The transport matches on method plus path and fails closed with a 404, so a
 * fixture that declares a different method or path than the client sends is
 * not a quiet mismatch: the speaker editor and the Regenerate button both
 * end in "Not available in the demo". Going through the client functions pins
 * the method and the path the screen actually uses.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createDemoTransport } from '../demoTransport';
import { setDemoTransport } from '../../utils/helpers';
import * as api from '../../api/transcriptionsApi';
import { ROUTES, createState } from './meetingNotes';

const MEETING = 'tr_demo_platform_review';

function install() {
    setDemoTransport(createDemoTransport(ROUTES, createState()));
}

afterEach(() => {
    setDemoTransport(null);
});

describe('meeting-notes demo fixtures', () => {
    it('a speaker rename answers the whole note, with the transcript re-labelled', async () => {
        install();
        const note = await api.updateSpeakers(MEETING, { renames: { 'Riley Fox': 'Riley Fox-Moreau' } });

        // The screen replaces its note with this answer: it has to BE the note.
        expect(note.id).toBe(MEETING);
        expect(note.speakers.map((s: { id: string }) => s.id)).toContain('Riley Fox-Moreau');
        expect(note.speakers.map((s: { id: string }) => s.id)).not.toContain('Riley Fox');
        const labels = new Set(note.segments.map((s: { speaker: string }) => s.speaker));
        expect(labels.has('Riley Fox-Moreau')).toBe(true);
        expect(labels.has('Riley Fox')).toBe(false);
        expect(note.transcript).toContain('Riley Fox-Moreau: ');
        expect(note.actionItems.find((a: { id: string }) => a.id === 'ai_1').assignee).toBe('Riley Fox-Moreau');

        // And it landed in memory: the next read sees it too.
        const again = await api.getTranscription(MEETING);
        expect(again.segments.some((s: { speaker: string }) => s.speaker === 'Riley Fox-Moreau')).toBe(true);
    });

    it('a speaker merge folds the turns into one speaker', async () => {
        install();
        const note = await api.updateSpeakers(MEETING, { merges: [{ from: ['Quinn Ellis', 'Riley Fox'], into: 'Quinn Ellis' }] });
        expect(note.speakers.map((s: { id: string }) => s.id)).toEqual(['Casey Hayes', 'Taylor Rivera', 'Quinn Ellis']);
        expect(note.segments.some((s: { speaker: string }) => s.speaker === 'Riley Fox')).toBe(false);
    });

    it('refuses a rename that would fuse two speakers, as the server does', async () => {
        install();
        await expect(api.updateSpeakers(MEETING, { renames: { 'Riley Fox': 'Quinn Ellis' } })).rejects.toThrow(/would both become/);
    });

    it('auto-detect in the speaker editor answers the note', async () => {
        install();
        const note = await api.reidentifySpeakers(MEETING, 'Casey Hayes, Riley Fox');
        expect(note.id).toBe(MEETING);
    });

    it('regenerate answers the shape the screen merges, stamped with the chosen template', async () => {
        install();
        const res = await api.regenerateSummary(MEETING, 'standup');
        expect(typeof res.summary).toBe('string');
        expect(res.summary.length).toBeGreaterThan(0);
        expect(Array.isArray(res.actionItems)).toBe(true);
        expect(Array.isArray(res.decisions)).toBe(true);
        expect(Array.isArray(res.questions)).toBe(true);
        expect(Array.isArray(res.chapters)).toBe(true);
        expect(res.artifactsRegenerated).toBe(true);
        expect(res.summaryTemplateId).toBe('builtin:standup');
    });

    it('lists the summary templates in the shape the regenerate menu and editor read', async () => {
        install();
        const tpl = await api.listSummaryTemplates();
        expect(tpl.builtins.map((b: { id: string }) => b.id)).toEqual(['general', 'standup', 'sales', 'interview', 'retrospective']);
        for (const b of tpl.builtins) expect(typeof b.prompt).toBe('string');
        expect(tpl.custom).toEqual([]);
        expect(tpl.defaultTemplateId).toBeNull();
    });
});
