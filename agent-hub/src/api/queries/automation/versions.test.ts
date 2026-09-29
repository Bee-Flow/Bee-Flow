import { describe, expect, it } from 'vitest';
import { parseFieldDiff, parseVersions } from './versions';

describe('parseVersions', () => {
    it('reads the handoff-5 row and sorts newest first', () => {
        const rows = parseVersions({
            versions: [
                { id: 'r3', version: 3, savedAt: '2026-09-22T10:00:00Z', savedBy: { id: 'u', name: 'admin' }, name: 'Approval', isLive: true, liveSince: '2026-09-22T10:00:00Z', isEditing: false, runs: { total: 36, failed: 1 }, descriptionJson: { code: 'step_added', params: { step: 'Talk' } } },
                { id: 'r5', version: 5, savedAt: '2026-09-28T10:55:00Z', savedBy: { name: 'admin' }, isLive: false, isEditing: true, descriptionJson: [{ code: 'setting_changed', params: { setting: 'Folder', step: 'Read' } }] },
            ],
        }, { liveVersion: null, currentVersion: null });
        expect(rows.map((r) => r.version)).toEqual([5, 3]);
        expect(rows[1]).toMatchObject({ name: 'Approval', isLive: true, savedByName: 'admin', runs: { total: 36, failed: 1 } });
        expect(rows[1].descriptionJson).toEqual([{ code: 'step_added', params: { step: 'Talk' } }]);
        expect(rows[0]).toMatchObject({ isEditing: true, isLive: false, runs: null });
    });

    it('fills live and editing from the automation row on the older shape', () => {
        const rows = parseVersions({
            versions: [
                { id: 'b', version: 2, savedByName: 'Tom', changeSummary: '1 step added' },
                { id: 'a', version: 1 },
                { junk: true },
            ],
        }, { liveVersion: 1, liveAt: '2026-09-20T00:00:00Z', currentVersion: 2 });
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({ version: 2, isEditing: true, isLive: false, savedByName: 'Tom', changeSummary: '1 step added' });
        expect(rows[1]).toMatchObject({ version: 1, isLive: true, liveSince: '2026-09-20T00:00:00Z', isEditing: false });
    });

    it('survives a body that is not a list', () => {
        expect(parseVersions(null, { liveVersion: null, currentVersion: null })).toEqual([]);
        expect(parseVersions({ versions: 'x' }, { liveVersion: null, currentVersion: null })).toEqual([]);
    });
});

describe('parseFieldDiff', () => {
    it('keeps the rows and the step id sets', () => {
        const d = parseFieldDiff({
            changes: [
                { stepId: 's2', stepNumber: 2, stepLabel: 'Read invoice', change: 'changed', setting: 'connection', settingLabel: 'Connection', before: 'bee-bot', after: 'finance' },
                { stepId: 's7', stepNumber: 7, stepLabel: 'Talk', change: 'added', after: 'Post' },
                { stepId: 's9', change: 'weird' },
            ],
            stepIds: { added: ['s7'], removed: [], changed: ['s2', 3] },
        });
        expect(d.changes).toHaveLength(3);
        expect(d.changes[0]).toMatchObject({ settingLabel: 'Connection', before: 'bee-bot', after: 'finance' });
        expect(d.changes[2]).toMatchObject({ change: 'changed', stepLabel: 's9', stepNumber: null });
        expect(d.stepIds).toEqual({ added: ['s7'], removed: [], changed: ['s2'] });
    });

    it('returns an empty diff for junk', () => {
        expect(parseFieldDiff(undefined)).toEqual({ changes: [], stepIds: { added: [], removed: [], changed: [] } });
    });
});
