/**
 * The source vocabulary against the web's own files: the schedule presets
 * (KnowledgeStudio/ScheduleMenu.jsx), the kinds the server creates
 * (sourceKinds.js and server sources.js) and the kind labels. Textual, like
 * the other lockstep tests: when this fails the web or the server changed.
 */

import fs from 'node:fs';
import path from 'node:path';

import { CREATABLE_KINDS, CRON_PRESETS, presetFor, refreshLabel, refreshModeLabel, ruleFor, sourceIcon, sourceKindLabel, sourceSubline } from './sources';

const REPO = path.resolve(__dirname, '../../../../..');
const STUDIO = path.join(REPO, 'agent-hub/src/components/admin/Studio/KnowledgeStudio');
const read = (p: string) => fs.readFileSync(p, 'utf8');
const t = (_k: string, fallback: string, p: Record<string, unknown> = {}) => fallback.replace(/\{(\w+)\}/g, (_, k: string) => String(p[k] ?? ''));

describe('sources ↔ the web and the server', () => {
    it('offers the web’s three schedule presets, same cron, same order', () => {
        const web = [...read(path.join(STUDIO, 'ScheduleMenu.jsx')).matchAll(/id: '(\w+)', cron: '([^']+)'/g)].map((m) => [m[1], m[2]]);
        expect(CRON_PRESETS.map((p) => [p.id, p.cron])).toEqual(web);
    });

    it('knows the kinds the server creates', () => {
        const server = read(path.join(REPO, 'server/routes/knowledgeBases/sources.js')).match(/const CREATABLE_KINDS = Object\.freeze\(\[([^\]]+)\]\)/);
        const web = read(path.join(STUDIO, 'sourceKinds.js')).match(/CREATABLE_KINDS = Object\.freeze\(\[([^\]]+)\]\)/);
        const parse = (m: RegExpMatchArray | null) => (m?.[1] ?? '').split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);
        expect([...CREATABLE_KINDS]).toEqual(parse(server));
        expect([...CREATABLE_KINDS]).toEqual(parse(web));
    });

    it('labels every kind the web labels, with the web’s English', () => {
        const src = read(path.join(STUDIO, 'sourceKinds.js'));
        for (const m of src.matchAll(/labelKey: '(knowledge\.kind\.(\w+))', labelFallback: '([^']+)'/g)) {
            expect(sourceKindLabel(t, m[2] as string)).toBe(m[3]);
        }
    });
});

describe('sublines and refresh words', () => {
    const base = { documentCount: 3, config: {}, createdByName: 'Ann' };

    it('says each kind the web’s way, one or many', () => {
        expect(sourceSubline(t, { ...base, kind: 'upload' })).toBe('uploaded · 3 files');
        expect(sourceSubline(t, { ...base, kind: 'upload', documentCount: 1 })).toBe('uploaded · 1 file');
        expect(sourceSubline(t, { ...base, kind: 'webpage', documentCount: 0 })).toBe('web page · 1 page');
        expect(sourceSubline(t, { ...base, kind: 'webpage', config: { crawl: { maxPages: 5 } } })).toBe('whole site · 3 pages');
        expect(sourceSubline(t, { ...base, kind: 'text' })).toBe('pasted text · by Ann');
        expect(sourceSubline(t, { ...base, kind: 'datatable', config: { tableName: 'Prices' } })).toBe('table Prices · 3 rows');
        expect(sourceSubline(t, { ...base, kind: 'meeting_tag', config: { fields: ['summary', 'actions', 'nope'] } })).toBe('Summary, Actions · 3 meetings');
        expect(sourceSubline(t, { ...base, kind: 'meeting_tag' })).toBe('Summary, Decisions · 3 meetings');
        expect(sourceSubline(t, { ...base, kind: 'mystery' })).toBe('imported · 3 documents');
        expect(sourceIcon('mystery')).toBe('FileText');
        expect(sourceIcon('webpage')).toBe('Globe');
    });

    it('names the refresh: a preset by its words, anything else as custom', () => {
        expect(refreshLabel(t, { refreshMode: 'manual', refreshCron: null })).toBe('Only when I ask');
        expect(refreshLabel(t, { refreshMode: 'schedule', refreshCron: '0 6 * * 1' })).toBe('Every Monday at 06:00');
        expect(refreshLabel(t, { refreshMode: 'schedule', refreshCron: '*/5 * * * *' })).toBe('Custom schedule (*/5 * * * *)');
        expect(refreshModeLabel(t, 'weird')).toBe('weird');
        expect(presetFor(' 0 6 1 * * ')?.id).toBe('monthly');
    });

    it('builds the rule the schedule sheet sends', () => {
        expect(ruleFor('manual')).toEqual({ mode: 'manual' });
        const rule = ruleFor('schedule');
        expect(rule.mode).toBe('schedule');
        expect(rule.cron).toBe('0 6 * * 1');
        expect(typeof rule.tz).toBe('string');
        expect(ruleFor('schedule', '0 6 * * *').cron).toBe('0 6 * * *');
    });
});
