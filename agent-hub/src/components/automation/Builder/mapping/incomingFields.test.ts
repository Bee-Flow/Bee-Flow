import { describe, expect, it } from 'vitest';
import { FIELDS_SHOWN, isSystemField, planIncomingFields, technicalPreview } from './incomingFields';

const f = (key: string) => ({ key, path: `trigger.output.${key}` });

describe('incomingFields — what the Comes-in column shows (artboard 4c)', () => {
    it('knows the plumbing keys', () => {
        for (const k of ['kind', 'source', 'id', 'provider', 'event', 'cron', 'etag', '_meta', 'fileId']) expect(isSystemField(k)).toBe(true);
        for (const k of ['name', 'path', 'size', 'subject', 'added_by']) expect(isSystemField(k)).toBe(false);
    });

    it('shows six, folds the rest behind "n more", and the system fields behind Technical details', () => {
        const fields = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'kind', 'etag'].map(f);
        const plan = planIncomingFields(fields, () => false);
        expect(plan.shown).toHaveLength(FIELDS_SHOWN);
        expect(plan.more).toBe(2);
        expect(plan.technical.map(x => x.key)).toEqual(['kind', 'etag']);
        expect(planIncomingFields(fields, () => false, true).more).toBe(0);
    });

    it('puts the fields this step uses on top, even a technical one', () => {
        const fields = ['a', 'b', 'id', 'c'].map(f);
        const plan = planIncomingFields(fields, p => p.endsWith('.c') || p.endsWith('.id'));
        expect(plan.shown.map(x => x.key)).toEqual(['id', 'c', 'a', 'b']);
        expect(plan.technical).toHaveLength(0);
    });

    it('previews the folded names', () => {
        expect(technicalPreview(['kind', 'id', 'provider', 'cron'].map(f))).toBe('kind, id, provider…');
    });
});
