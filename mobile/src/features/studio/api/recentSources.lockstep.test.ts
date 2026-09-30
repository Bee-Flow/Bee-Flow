/**
 * RECENT_SOURCES held to the web's STUDIO_RECENT_SOURCES
 * (agent-hub/src/utils/studioRecentSources.js) — a differential test: the web
 * module is pure, so it runs here next to the port, section by section, on
 * the same bodies and rows. A renamed URL, envelope, name or time field, or a
 * status rule that moved, fails here rather than in a list that quietly
 * empties.
 *
 * When this fails, the web side changed: update recentSources.ts to match.
 */

import fs from 'node:fs';
import path from 'node:path';

import { RECENT_SOURCES } from './recentSources';

const WEB = path.resolve(__dirname, '../../../../../agent-hub/src/utils/studioRecentSources.js');

type Row = Record<string, unknown>;

interface WebSource {
    url: string;
    pick: (body: unknown) => unknown;
    map: (row: Row) => { name?: unknown; updatedAt?: unknown };
    status?: (row: Row) => string;
}

const describeIfWeb = fs.existsSync(WEB) ? describe : describe.skip;

/** A row with every spelling any section reads, so each accessor finds its own field. */
const ROW: Row = {
    id: 'r1',
    name: 'By name',
    title: 'By title',
    fileName: 'recording.m4a',
    updatedAt: '2026-09-01T10:00:00Z',
    updated_at: '2026-08-01T10:00:00Z',
};

/** Rows that exercise the status rules: publish flags, versions, activity, phases. */
const STATUS_ROWS: Row[] = [
    {},
    { isPublished: true },
    { is_published: 'f' },
    { isPublished: true, publishedVersion: 2, definitionVersion: 3 },
    { isPublished: true, publishedVersion: 3, definitionVersion: 3 },
    { isPublished: true, publishedVersion: null, definitionVersion: 1 },
    { published_version: 0 },
    { publishedVersion: 4 },
    { publishedVersion: 'x' },
    { isDraft: true },
    { lastStatus: 'error', isActive: true },
    { isActive: true },
    { isActive: false },
    { status: 'failed' },
    { status: 'completed' },
    { status: ' queued ' },
    { status: 'done' },
    { status: 'stopped' },
    { status: 'active', phases: [{ status: 'awaiting' }] },
    { status: 'active', phases: [{ status: 'running' }, { status: 'failed' }] },
    { status: 'active' },
];

/** Every envelope any section unwraps, plus a bare array, so each pick finds its own. */
const BODIES: unknown[] = [
    [ROW],
    Object.fromEntries(
        ['automations', 'webpages', 'apps', 'datatables', 'transcriptions', 'playbooks', 'projects'].map((key) => [key, [{ ...ROW, id: key }]]),
    ),
    null,
    'not json',
];

describeIfWeb('RECENT_SOURCES matches the web', () => {
    // Required inside the tests: a skipped describe still runs its body.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const web = () => (require(WEB) as { STUDIO_RECENT_SOURCES: Record<string, WebSource> }).STUDIO_RECENT_SOURCES;
    const ids = () => Object.keys(RECENT_SOURCES) as (keyof typeof RECENT_SOURCES)[];

    it('lists the same sections', () => {
        expect(Object.keys(RECENT_SOURCES).sort()).toEqual(Object.keys(web()).sort());
    });

    it('asks the same URL, query included', () => {
        for (const id of ids()) {
            const { url, query } = RECENT_SOURCES[id];
            const search = query ? `?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))}` : '';
            expect({ id, url: `${url}${search}` }).toEqual({ id, url: web()[id]?.url });
        }
    });

    it('unwraps the same envelope', () => {
        for (const id of ids()) {
            for (const body of BODIES) {
                expect({ id, rows: RECENT_SOURCES[id].pick(body) ?? null }).toEqual({ id, rows: web()[id]?.pick(body) ?? null });
            }
        }
    });

    it('reads the name and the time from the same fields', () => {
        for (const id of ids()) {
            const mapped = web()[id]?.map(ROW);
            const port = RECENT_SOURCES[id];
            expect({ id, name: port.name(ROW), updatedAt: port.updatedAt(ROW) }).toEqual({
                id,
                name: mapped?.name,
                updatedAt: mapped?.updatedAt,
            });
        }
    });

    it('gives a status where the web does, by the same rules, and none where it has none', () => {
        for (const id of ids()) {
            const theirs = web()[id]?.status;
            const ours = RECENT_SOURCES[id].status;
            expect({ id, hasStatus: Boolean(ours) }).toEqual({ id, hasStatus: Boolean(theirs) });
            if (!ours || !theirs) continue;
            for (const row of STATUS_ROWS) expect({ id, row, status: ours(row) }).toEqual({ id, row, status: theirs(row) });
        }
    });
});
