import { describe, expect, it } from 'vitest';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import type { VersionRow } from '../../../../api/queries/automation/versions';
import { describeVersion, formatValue, groupVersions, milestonesOnly, settingName, versionMeta, versionTitle, worksTheSame } from './versionText';

// The fallback text with its {params} filled in, like the real hook without a catalogue.
const t: TranslateFn = (_key, fallback, params) => {
    const text = typeof fallback === 'string' ? fallback : _key;
    return text.replace(/\{(\w+)\}/g, (m, k) => (params && k in params ? String(params[k]) : m));
};

const row = (over: Partial<VersionRow>): VersionRow => ({
    id: `r${over.version ?? 1}`, version: 1, savedAt: null, savedByName: null, name: null, description: null,
    descriptionJson: [], changeSummary: null, isLive: false, liveSince: null, isEditing: false, runs: null, ...over,
});

describe('describeVersion', () => {
    it('turns a code into plain language', () => {
        expect(describeVersion(row({ descriptionJson: [{ code: 'setting_changed', params: { setting: 'Folder', step: 'Read invoice' } }] }), t))
            .toBe('Folder changed in "Read invoice"');
        expect(describeVersion(row({ descriptionJson: [{ code: 'step_added', params: { step: 'Post in Talk' } }] }), t))
            .toBe('Step added: "Post in Talk"');
    });

    it('summarises several codes and falls back to the text', () => {
        expect(describeVersion(row({ descriptionJson: [
            { code: 'step_added', params: { step: 'A' } }, { code: 'trigger_changed', params: {} }, { code: 'nope', params: {} },
        ] }), t)).toBe('Step added: "A" and 1 more');
        expect(describeVersion(row({ descriptionJson: [{ code: 'nope', params: {} }], description: 'Server text' }), t)).toBe('Server text');
        expect(describeVersion(row({ changeSummary: '2 steps added' }), t)).toBe('2 steps added');
        expect(describeVersion(row({}), t)).toBe('Saved changes');
    });

    it('knows the server codes for copies and automation settings', () => {
        expect(describeVersion(row({ descriptionJson: [{ code: 'duplicated_from', params: { title: 'Invoices' } }] }), t))
            .toBe('Copied from "Invoices"');
        expect(describeVersion(row({ descriptionJson: [{ code: 'settings_changed', params: { setting: 'Retries', settingKey: 'max' } }] }), t))
            .toBe('Retries changed');
    });

    it('translates a setting by its code and falls back to the English label', () => {
        const nl: TranslateFn = (key, fallback) => (key === 'automations.versions.setting.folder' ? 'Map' : String(fallback));
        expect(settingName(nl, 'folder', 'Folder')).toBe('Map');
        expect(settingName(nl, 'other', 'Other')).toBe('Other');
        expect(settingName(nl, null, 'Label')).toBe('Label');
    });

    it('titles a milestone by its name', () => {
        expect(versionTitle(row({ name: 'Approval above 1,000', description: 'x' }), t)).toBe('Approval above 1,000');
    });
});

describe('versionMeta', () => {
    const now = new Date('2026-09-28T12:00:00');
    it('shows date, author and runs', () => {
        const meta = versionMeta(row({ savedAt: '2026-09-22T09:00:00', savedByName: 'admin', runs: { total: 36, failed: 1 } }), t, now);
        expect(meta).toMatch(/ · admin · 36 runs, 1 failed$/);
        expect(meta).not.toMatch(/Today/);
    });

    it('says Today for today and "works the same" for a reorder without runs', () => {
        const r = row({ savedAt: '2026-09-28T10:55:00', savedByName: 'admin', descriptionJson: [{ code: 'steps_reordered', params: {} }] });
        expect(worksTheSame(r)).toBe(true);
        expect(versionMeta(r, t, now)).toMatch(/^Today .* · admin · works the same$/);
    });
});

describe('groupVersions', () => {
    const rows = [row({ version: 5, isEditing: true }), row({ version: 4 }), row({ version: 3, isLive: true, name: 'M' }), row({ version: 2 }), row({ version: 1 })];

    it('splits into Not live yet / Live / Earlier', () => {
        const g = groupVersions(rows);
        expect(g.map((x) => [x.key, x.rows.map((r) => r.version)])).toEqual([
            ['pending', [5, 4]], ['live', [3]], ['earlier', [2, 1]],
        ]);
    });

    it('puts everything under Not live yet when never live', () => {
        const g = groupVersions([row({ version: 2, isEditing: true }), row({ version: 1 })]);
        expect(g).toHaveLength(1);
        expect(g[0].key).toBe('pending');
    });

    it('milestones only keeps named, live and editing rows', () => {
        expect(milestonesOnly(rows).map((r) => r.version)).toEqual([5, 3]);
    });
});

describe('formatValue', () => {
    it('renders scalars and clips objects', () => {
        expect(formatValue(null)).toBe('');
        expect(formatValue(3)).toBe('3');
        expect(formatValue({ a: 1 })).toBe('{"a":1}');
        expect(formatValue({ a: 'x'.repeat(300) }).length).toBe(140);
    });
});
