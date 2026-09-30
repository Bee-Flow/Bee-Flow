/**
 * The Versions and Installs readings held to the web's (differential): the
 * web's admin/Studio/Solutions/releaseModel.js and this port — the readers
 * in api/packageReaders.ts plus releases.ts — on the same server bodies.
 *
 * The web model reads a `{ status, data }` remote; the phone's reader throws
 * where the web answers `unreadable`, and the query's error state is the
 * phone's `unreadable`. Both directions are pinned below.
 */

import path from 'node:path';

import { groupNoteRows, installsBadge } from './releases';
import { readInstallCounts, readReleases } from '../api/packageReaders';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const web = require(path.resolve(__dirname, '../../../../../agent-hub/src/components/admin/Studio/Solutions/releaseModel.js'));

const NOTES = {
    entities: [
        { kind: 'automation', entityId: 'r1', name: 'Intake', change: 'changed', text: 'Now asks for a date.' },
        { kind: 'app', entityId: 'a1', name: '  ', change: 'changed', text: null },
        { kind: 'webpage', entityId: 'w1', name: 'Form', change: 'added', text: '' },
        { kind: 'datatable', entityId: 't1', name: 'Leads', change: 'unchanged', text: null },
        { kind: 'agent', entityId: 'g1', name: 'Helper', change: 'renamed', text: null },
    ],
    omitted: 3,
    textsDropped: true,
};

const BODIES = [
    { releases: [] },
    { releases: [{ id: 'r2', version: 2, publishedAt: '2026-09-01T00:00:00Z', notes: NOTES }] },
    { releases: [{ id: 'r1', version: 0, publishedAt: null, notes: {} }, { id: '', version: 3 }] },
    { releases: [{ id: 'r3', version: 1.5, notes: { entities: [], omitted: -2 } }] },
];

describe('the release history matches the web', () => {
    it.each(BODIES.map((b, i) => [i, b] as const))('body %i', (_i, body) => {
        const theirs = web.readReleases({ status: 'ok', data: body });
        const ours = readReleases(body);
        expect(theirs.state).toBe('ok');
        expect(ours.map((r) => [r.id, r.version, r.publishedAt])).toEqual(
            theirs.releases.map((r: { id: string; version: number | null; publishedAt: string | null }) => [r.id, r.version, r.publishedAt]),
        );
        ours.forEach((release, n) => {
            const note = web.noteRowsOf(theirs.releases[n]);
            expect(release.notes.entities === null ? 'unrecorded' : 'ok').toBe(note.state);
            expect(release.notes.omitted).toBe(note.omitted);
            expect(release.notes.textsDropped).toBe(note.textsDropped);
            expect(release.notes.entities ?? []).toEqual(note.rows);
            const g = groupNoteRows(release.notes.entities ?? []);
            expect(g).toEqual(web.groupNoteRows(note.rows));
        });
    });

    it('refuses a body the web reads as unreadable', () => {
        for (const body of [{}, { releases: 'x' }, null]) {
            expect(web.readReleases({ status: 'ok', data: body }).state).toBe('unreadable');
            expect(() => readReleases(body)).toThrow();
        }
    });
});

describe('the install count matches the web', () => {
    it.each([
        [{ installsHere: 2, installsElsewhere: 1 }],
        [{ installsHere: 0, installsElsewhere: 0 }],
        [{ installsHere: 3.7, installsElsewhere: null }],
        [{ installsHere: -1, installsElsewhere: 4 }],
    ])('%j', (body) => {
        const theirs = web.readInstalls({ status: 'ok', data: body });
        const ours = readInstallCounts(body);
        expect({ state: 'ok', ...ours }).toEqual(theirs);
    });

    it('refuses an answer with no number in it, as the web does', () => {
        expect(web.readInstalls({ status: 'ok', data: { installsHere: null } }).state).toBe('unreadable');
        expect(() => readInstallCounts({ installsHere: null })).toThrow();
    });

    it('badges only a known total above zero', () => {
        expect(installsBadge({ here: 2, elsewhere: 1 })).toBe(3);
        expect(installsBadge({ here: 0, elsewhere: 0 })).toBeNull();
        expect(installsBadge({ here: 2, elsewhere: null })).toBeNull();
        expect(installsBadge(null)).toBeNull();
    });
});
