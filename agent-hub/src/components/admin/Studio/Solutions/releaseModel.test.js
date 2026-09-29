// @vitest-environment node
import { describe, it, expect } from 'vitest';

import { groupNoteRows, noteRowsOf, readInstalls, readReleases, versionOrNull } from './releaseModel';

/**
 * Het leesmodel van de Versies- en Installaties-tab.
 *
 * Elke test hieronder houdt één paar antwoorden uit elkaar dat er op het scherm
 * hetzelfde uit zou zien:
 *
 *   "nog nooit gepubliceerd"      vs  "de geschiedenis kon niet gelezen worden"
 *   "er is niets veranderd"       vs  "er is geen diff vastgelegd"
 *   "geen nieuws"                 vs  "geen woorden" (het model viel om)
 *   "niemand heeft dit"           vs  "we konden niet tellen"
 *
 * De tweede van elk paar is telkens het antwoord dat verdwijnt als iemand een
 * `|| []` of een `|| 0` op de verkeerde plek zet.
 */

describe('the release history', () => {
    it('a failed read is NOT an empty history', () => {
        expect(readReleases({ status: 'error', data: null })).toEqual({ state: 'unreadable', releases: [] });
    });

    it('a 200 whose body has no releases array is unreadable, not zero releases', () => {
        // Een route die van vorm verandert mag geen Oplossing ongepubliceerd
        // laten lijken.
        expect(readReleases({ status: 'ok', data: {} }).state).toBe('unreadable');
        expect(readReleases({ status: 'ok', data: { releases: 'none' } }).state).toBe('unreadable');
    });

    it('an empty list from a successful read IS "none yet"', () => {
        expect(readReleases({ status: 'ok', data: { releases: [] } })).toEqual({ state: 'ok', releases: [] });
    });

    it('not asked yet reads as loading, never as unreadable', () => {
        expect(readReleases(undefined).state).toBe('loading');
        expect(readReleases({ status: 'idle' }).state).toBe('loading');
    });

    it('builds each row from an allow-list, so a new column does not travel', () => {
        const { releases } = readReleases({
            status: 'ok',
            data: {
                releases: [{
                    id: 'rel_1', version: 3, publishedAt: '2026-09-01T00:00:00Z',
                    notes: { entities: [] },
                    publishedBy: 'u_alice', manifest: { huge: true }, secretColumn: 'x',
                }],
            },
        });
        expect(Object.keys(releases[0]).sort()).toEqual(['id', 'notes', 'publishedAt', 'version']);
        expect(JSON.stringify(releases[0])).not.toMatch(/alice|secretColumn/);
    });

    it('a row without an id is not a row', () => {
        const { releases } = readReleases({ status: 'ok', data: { releases: [{ version: 2 }, null, 'x'] } });
        expect(releases).toEqual([]);
    });

    it('a version that is not a positive integer reads as unknown, not as v0', () => {
        expect(versionOrNull(0)).toBeNull();
        expect(versionOrNull('3')).toBeNull();
        expect(versionOrNull(3)).toBe(3);
        const { releases } = readReleases({ status: 'ok', data: { releases: [{ id: 'r', version: 0 }] } });
        expect(releases[0].version).toBeNull();
    });
});

describe('what one version says it changed', () => {
    it('NO RECORDED DIFF IS NOT "NOTHING CHANGED"', () => {
        expect(noteRowsOf({ id: 'r', notes: null }).state).toBe('unrecorded');
        expect(noteRowsOf({ id: 'r', notes: {} }).state).toBe('unrecorded');
        expect(noteRowsOf(null).state).toBe('unrecorded');
    });

    it('a recorded but empty diff is a read answer', () => {
        expect(noteRowsOf({ notes: { entities: [] } })).toEqual({
            state: 'ok', rows: [], omitted: 0, textsDropped: false,
        });
    });

    it('THE MODEL FALLING OVER LEAVES THE DIFF INTACT — changed with no line is flagged, not hidden', () => {
        const { rows } = noteRowsOf({
            notes: {
                entities: [
                    { kind: 'app', entityId: 'app_1', name: 'Desk', change: 'changed', text: null },
                    { kind: 'app', entityId: 'app_2', name: 'Till', change: 'changed', text: 'Two buttons moved.' },
                    { kind: 'agent', entityId: 'agt_1', name: 'Helper', change: 'unchanged', text: null },
                ],
            },
        });
        expect(rows[0].summaryMissing).toBe(true);
        expect(rows[1].summaryMissing).toBe(false);
        // "geen nieuws" is iets anders dan "geen woorden": een ongewijzigde rij
        // is nooit een ontbrekende samenvatting.
        expect(rows[2].summaryMissing).toBe(false);
    });

    it('a blank line counts as no line', () => {
        const { rows } = noteRowsOf({ notes: { entities: [{ kind: 'app', entityId: 'a', change: 'changed', text: '   ' }] } });
        expect(rows[0].text).toBeNull();
        expect(rows[0].summaryMissing).toBe(true);
    });

    it('a nameless entity falls back to its ref rather than to an empty row', () => {
        const { rows } = noteRowsOf({ notes: { entities: [{ kind: 'app', entityId: 'app_7', change: 'added' }] } });
        expect(rows[0].name).toBe('app_7');
    });

    it('carries the two reasons a note can be thinner than the truth', () => {
        const note = noteRowsOf({ notes: { entities: [], omitted: 4, textsDropped: true } });
        expect(note.omitted).toBe(4);
        expect(note.textsDropped).toBe(true);
    });

    it('an unrecognised change is counted as unplaceable, never folded into "unchanged"', () => {
        const groups = groupNoteRows([
            { change: 'added' }, { change: 'changed' }, { change: 'unchanged' },
            { change: 'removed' }, { change: '' }, null,
        ]);
        expect(groups.added.length).toBe(1);
        expect(groups.changed.length).toBe(1);
        expect(groups.unchanged.length).toBe(1);
        expect(groups.unreadable).toBe(3);
    });
});

describe('how often this was installed', () => {
    it('A FAILED COUNT IS NOT ZERO', () => {
        expect(readInstalls({ status: 'error', data: null })).toEqual({ state: 'unreadable', here: null, elsewhere: null });
    });

    it('a 200 with neither number is unreadable, not "nobody has it"', () => {
        expect(readInstalls({ status: 'ok', data: {} }).state).toBe('unreadable');
        expect(readInstalls({ status: 'ok', data: { installsHere: null, installsElsewhere: null } }).state).toBe('unreadable');
    });

    it('zero from a read answer IS zero', () => {
        expect(readInstalls({ status: 'ok', data: { installsHere: 0, installsElsewhere: 0 } }))
            .toEqual({ state: 'ok', here: 0, elsewhere: 0 });
    });

    it('one unknown half does not drag the other down to zero', () => {
        expect(readInstalls({ status: 'ok', data: { installsHere: 3, installsElsewhere: null } }))
            .toEqual({ state: 'ok', here: 3, elsewhere: null });
    });

    it('reads ONLY the two counts — nothing else from the body reaches the screen', () => {
        const out = readInstalls({
            status: 'ok',
            data: {
                installsHere: 2, installsElsewhere: 1,
                projects: [{ id: 'p9', name: 'Acme onboarding', organizationId: 'org_b' }],
                organizations: ['org_b'],
            },
        });
        expect(out).toEqual({ state: 'ok', here: 2, elsewhere: 1 });
        expect(JSON.stringify(out)).not.toMatch(/Acme|org_b|p9/);
    });

    it('a nonsense count is unknown rather than a negative number on screen', () => {
        expect(readInstalls({ status: 'ok', data: { installsHere: -4, installsElsewhere: 2 } }))
            .toEqual({ state: 'ok', here: null, elsewhere: 2 });
        expect(readInstalls({ status: 'ok', data: { installsHere: '7', installsElsewhere: NaN } }).state)
            .toBe('unreadable');
    });
});
