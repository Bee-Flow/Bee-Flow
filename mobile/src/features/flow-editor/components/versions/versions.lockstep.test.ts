/**
 * DIFFERENTIAL lockstep: the version history's words and groups against the
 * web's `Builder/versions/versionText.ts` (handoff 5 replaced
 * VersionHistoryPanel.jsx with the Versions tab), run on the same rows; the
 * row's chips and the group names against the tab's VersionList.tsx — plus
 * unit tests for the raw view's line diff and one-column fold, which are the
 * phone's own since the web compares per setting.
 */

import fs from 'node:fs';

import type { FlowVersionSummary } from '@/features/flow-editor/api';
import { BUILDER, requireWeb, webPath } from '@/features/flow-editor/bindings/testing/web';

import { definitionDiff, diffLines, LCS_MAX_CELLS, stableStringify, unifiedHunks } from './versionsModel';
import { describeVersion, groupLabel, groupVersions, settingName, shortWhen, versionMeta, versionTitle, worksTheSame } from './versionText';

const web = requireWeb(`${BUILDER}/versions/versionText.ts`);
const LIST = fs.readFileSync(webPath(`${BUILDER}/versions/VersionList.tsx`), 'utf8');

const english = (_key: string, fallback: string, params?: Record<string, string | number>) =>
    fallback.replace(/\{(\w+)\}/g, (m, k: string) => (params && k in params ? String(params[k]) : m));
const keyed = (key: string, fallback: string, params?: Record<string, string | number>) => `${key}|${english(key, fallback, params)}`;

const row = (over: Partial<FlowVersionSummary>): FlowVersionSummary => ({
    id: `r${over.version ?? 1}`, automationId: 'a', version: 1, savedByUserId: null, savedAt: null, changeSummary: null, savedByName: null,
    name: null, description: null, descriptionJson: [], isLive: false, liveSince: null, isEditing: false, runs: null, ...over,
});
const entry = (code: string, params: Record<string, unknown> = {}) => ({ code, params });

const DESCRIBED: FlowVersionSummary[] = [
    row({}), row({ changeSummary: '2 steps added' }), row({ description: 'Server text', changeSummary: 'x' }),
    row({ name: 'Approval above 1,000', description: 'x' }),
    ...[
        entry('created'), entry('created_from_template', { template: 'Invoices' }), entry('duplicated_from', { title: 'Mail' }),
        entry('step_added', { step: 'Post in Talk' }), entry('step_removed', { step: 'A' }), entry('step_changed', { step: 'B' }),
        entry('setting_changed', { setting: 'Folder', settingKey: 'folder', step: 'Read invoice' }), entry('setting_changed', { setting: 'Odd', settingKey: '9x', step: 'S' }),
        entry('setting_changed', { settingKey: 'retries', step: 'S' }), entry('step_renamed', { step: 'C' }), entry('steps_reordered'), entry('layout_changed'),
        entry('connections_changed'), entry('trigger_changed'), entry('settings_changed'), entry('settings_changed', { setting: 'Retries', settingKey: 'max' }),
        entry('description_changed'), entry('restored', { version: 3 }), entry('nope'),
    ].map((e) => row({ descriptionJson: [e] })),
    row({ descriptionJson: [entry('step_added', { step: 'A' }), entry('trigger_changed'), entry('nope')] }),
    row({ descriptionJson: [entry('nope')], description: 'Fallback' }),
    row({ descriptionJson: [entry('steps_reordered'), entry('layout_changed')] }),
];

describe('the words match the web', () => {
    it.each([['English', english], ['keys', keyed]] as const)('describes, titles and names a setting as the web does (%s)', (_label, t) => {
        for (const v of DESCRIBED) {
            expect(describeVersion(v, t)).toBe(web.describeVersion?.(v, t));
            expect(versionTitle(v, t)).toBe(web.versionTitle?.(v, t));
            expect(worksTheSame(v)).toBe(web.worksTheSame?.(v));
        }
        for (const [code, label] of [['folder', 'Folder'], ['other', ''], [null, 'Label'], ['9x', 'Odd'], [5, null], ['a b', 'Spaced']]) {
            expect(settingName(t, code, label)).toBe(web.settingName?.(t, code, label));
        }
    });

    it('dates and meta lines as the web does', () => {
        const now = new Date('2026-09-28T12:00:00');
        for (const iso of [null, '', 'nonsense', '2026-09-28T10:55:00', '2026-09-22T09:00:00', '2025-01-01T00:00:00Z']) {
            expect(shortWhen(iso, english, now)).toBe(web.shortWhen?.(iso, english, now));
        }
        const metas = [
            row({ savedAt: '2026-09-22T09:00:00', savedByName: 'admin', runs: { total: 36, failed: 1 } }),
            row({ savedAt: '2026-09-28T10:55:00', savedByName: 'admin', descriptionJson: [entry('steps_reordered')] }),
            row({ runs: { total: 4, failed: 0 } }), row({ runs: { total: 0, failed: 0 }, descriptionJson: [entry('layout_changed')] }), row({}),
        ];
        for (const v of metas) for (const t of [english, keyed]) expect(versionMeta(v, t, now)).toBe(web.versionMeta?.(v, t, now));
    });

    it('groups into Not live yet / Live / Earlier as the web does', () => {
        const lists = [
            [],
            [row({ version: 2, isEditing: true }), row({ version: 1 })],
            [row({ version: 5, isEditing: true }), row({ version: 4 }), row({ version: 3, isLive: true, name: 'M' }), row({ version: 2 }), row({ version: 1 })],
            [row({ version: 3, isLive: true, isEditing: true }), row({ version: 2 }), row({ version: 1 })],
        ];
        for (const list of lists) expect(groupVersions(list)).toEqual(web.groupVersions?.(list));
    });
});

describe('the list reads as the web tab does', () => {
    const pairs = (src: string) => [...src.matchAll(/\bt\(\s*'(routines\.versions\.[a-zA-Z_.]+)',\s*'([^']*)'/g)].map((m) => `${m[1]}|${m[2]}`);

    it('names the groups with the tab\'s words', () => {
        for (const key of ['pending', 'live', 'earlier'] as const) {
            const en = groupLabel(key, english);
            expect(LIST).toContain(`${key}: t('routines.versions.group.${key}', '${en}')`);
            expect(groupLabel(key, keyed)).toBe(`routines.versions.group.${key}|${en}`);
        }
    });

    it('puts the tab\'s chips on a row', () => {
        const row = fs.readFileSync(`${__dirname}/VersionRow.tsx`, 'utf8');
        const mine = pairs(row);
        expect(mine.length).toBeGreaterThanOrEqual(4);
        for (const pair of mine) expect(pairs(LIST)).toContain(pair);
        expect(LIST).toContain('{versionTitle(row, t)}');
        expect(LIST).toContain('{versionMeta(row, t)}');
        expect(LIST).toContain('const liveSince = shortWhen(row.liveSince, t);');
    });
});

describe('the raw view (the phone\'s own)', () => {
    it('stringifies with sorted keys and keeps array order', () => {
        expect(stableStringify({ b: 1, a: [{ d: 1, c: 2 }, 3] })).toBe(JSON.stringify({ a: [{ c: 2, d: 1 }, 3], b: 1 }, null, 2));
        expect(stableStringify(null)).toBe('{}');
    });

    it('diffs lines as an LCS script', () => {
        expect(diffLines(['a', 'b', 'c'], ['a', 'x', 'c', 'd'])).toEqual([
            { kind: 'keep', left: 'a', right: 'a' }, { kind: 'del', left: 'b', right: '' }, { kind: 'ins', left: '', right: 'x' },
            { kind: 'keep', left: 'c', right: 'c' }, { kind: 'ins', left: '', right: 'd' },
        ]);
    });

    it('falls back to a coarse script above the cap', () => {
        const big = Array.from({ length: 1500 }, (_, i) => `line ${i}`);
        expect((big.length + 1) ** 2).toBeGreaterThan(LCS_MAX_CELLS);
        const out = diffLines(big, big.map((l) => `${l}!`));
        expect(out.slice(0, 1500).every((r) => r.kind === 'del')).toBe(true);
        expect(out.slice(1500).every((r) => r.kind === 'ins')).toBe(true);
    });

    it('keeps two lines of context around a change and folds the rest', () => {
        const a = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
        const b = ['1', '2', '3', '4', 'five', '6', '7', '8', '9'];
        const out = unifiedHunks(diffLines(a, b));
        expect(out.map((l) => (l.kind === 'gap' ? `…${l.count}` : `${l.kind}:${l.text}`))).toEqual([
            '…2', 'keep:3', 'keep:4', 'del:5', 'ins:five', 'keep:6', 'keep:7', '…2',
        ]);
    });

    it('says nothing changed with a single fold', () => {
        expect(definitionDiff({ a: 1, b: 2 }, { b: 2, a: 1 })).toEqual([{ kind: 'gap', count: 4, key: 'gap-end' }]);
    });
});
