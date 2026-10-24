/**
 * What the Versions and Installations tabs get back from the server, and what that
 * means — pure, without a browser, without text.
 *
 * Same contract as solutionOverviewModel.js next to it: every function returns a
 * STATE, never a sentence. The screen renders that state through `t()`. A helper
 * that returned prose would put copy where no translator can reach.
 *
 * ── The one mistake these two tabs must not make ──────────────────────────
 *
 * “There is nothing” and “we could not read it” both look like an empty list. On
 * these two tabs that difference is bigger than elsewhere:
 *
 *   - AN EMPTY VERSION LIST reads as “this Solution has never been published”,
 *     whereas the installations elsewhere do assume that it has.
 *   - AN INSTALLATION COUNTER THAT BECOMES ZERO reads as “nobody uses this”, and
 *     that is precisely the answer on which someone decides to throw something away.
 *
 * Therefore every answer here carries a `state`, and `ok` with an empty list is
 * reachable only via a SUCCESSFUL read. `unreadable` is not an error you make go
 * away, but an answer that the screen states out loud.
 *
 * ── The counter is by definition not complete ──────────────────────────────
 *
 * `projects.installed_from_blueprint_id` is written at a GALLERY install and at a
 * file install whose origin the server has checked; an installation on a DIFFERENT
 * instance is invisible, and an origin that could not be verified does not count.
 * There is therefore no `complete: true` for this number, and this model offers no
 * flag for it either: the screen ALWAYS says “at least n on this instance”. A flag
 * would let a server that sets it to true by accident remove that sentence.
 */

/** Een lees-toestand zoals `useRemote` hem draagt; `T` is de vorm die de route belooft. */
export interface ReleaseRemote<T> { status?: string; data?: T | null }

/**
 * A release row as it came over the wire. `id`, `publishedAt` and `notes` are vetted
 * below. `version` is here only as `number` because the comparison `> 0` wants to
 * see a number; `versionOrNull` tolerates any value.
 */
interface RawRelease { id?: unknown; version: number; publishedAt?: unknown; notes?: unknown }

/** De notitie van één release, zoals hij over de lijn kwam. */
export interface ReleaseNotes { entities?: unknown; omitted?: unknown; textsDropped?: unknown }

export interface ReleaseRow {
    id: string;
    version: number | null;
    publishedAt: string | null;
    notes: ReleaseNotes | null;
}

export interface ReleasesBody { releases?: unknown }

export interface InstallsBody { installsHere?: unknown; installsElsewhere?: unknown }

/** Een entiteitsregel zoals hij over de lijn kwam. */
interface RawNoteRow { entityId?: unknown; name?: unknown; text?: unknown; kind?: unknown; change?: unknown }

export interface NoteRow {
    kind: string;
    ref: string;
    name: string;
    change: string;
    text: string | null;
    summaryMissing: boolean;
}

export interface NoteRows {
    state: 'unrecorded' | 'ok';
    rows: NoteRow[];
    omitted: number;
    textsDropped: boolean;
}

export interface NoteGroups {
    added: NoteRow[];
    changed: NoteRow[];
    unchanged: NoteRow[];
    unreadable: number;
}

/** A whole, non-negative number, or null. `null` remains null — never 0. */
function countOrNull(value: unknown) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const n = Math.trunc(value);
    return n >= 0 ? n : null;
}

/** A version number as the server counts it: whole and greater than zero. */
export function versionOrNull(value: number) {
    return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * One release row, built from an EXPLICIT allow-list — not by taking keys out of the
 * row. A column that is added to `project_releases` next year does not automatically
 * reach the screen. Without an id there is no row.
 */
function releaseRow(row: RawRelease | null | undefined) {
    if (!row || typeof row !== 'object') return null;
    if (typeof row.id !== 'string' || !row.id) return null;
    return {
        id: row.id,
        version: versionOrNull(row.version),
        publishedAt: typeof row.publishedAt === 'string' ? row.publishedAt : null,
        notes: (row.notes && typeof row.notes === 'object' && !Array.isArray(row.notes)) ? row.notes : null,
    };
}

/**
 * De publicatiegeschiedenis, uit het antwoord van de releases-route.
 *
 * @param remote  Zoals useRemote/`fetch`-state hem draagt.
 */
export function readReleases(remote: ReleaseRemote<ReleasesBody> | null | undefined): { state: 'loading' | 'unreadable' | 'ok'; releases: ReleaseRow[] } {
    const status = remote?.status;
    if (status === 'idle' || status === 'loading' || !status) return { state: 'loading', releases: [] };
    if (status !== 'ok') return { state: 'unreadable', releases: [] };

    const list = remote?.data?.releases;
    // NO array = no answer. A body without `releases` is not “zero publications”:
    // that would let a route that changes shape silently read as a Solution that
    // was never released.
    if (!Array.isArray(list)) return { state: 'unreadable', releases: [] };

    return { state: 'ok', releases: list.map(releaseRow).filter(Boolean) as ReleaseRow[] };
}

/** One entity line of a note, again from an allow-list. */
function noteRow(row: RawNoteRow | null | undefined): NoteRow | null {
    if (!row || typeof row !== 'object') return null;
    const ref = typeof row.entityId === 'string' ? row.entityId : '';
    const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : ref;
    const text = typeof row.text === 'string' && row.text.trim() ? row.text.trim() : null;
    return {
        kind: typeof row.kind === 'string' ? row.kind : '',
        ref,
        name,
        change: typeof row.change === 'string' ? row.change : '',
        text,
        // `change: 'changed'` WITH `text: null` means “we could not write it down” — the
        // opposite of `unchanged`, which means “no news”. The same question as
        // summaryMissing() on the server, and the only place where this screen answers it.
        summaryMissing: row.change === 'changed' && !text,
    };
}

/**
 * The note for one release: the rows of the boolean diff, plus whatever came of
 * the text layer.
 *
 * THREE STATES, and the difference between them is the whole reason this function
 * exists:
 *
 *   unrecorded  no diff at all has been recorded for this version (a publication
 *               from before the release table, or a note that could not be saved).
 *               NOT “nothing has changed”.
 *   ok          the diff is there. It may be empty — a Solution without entities —
 *               but then that is a read answer.
 *
 * `textsDropped` is the third: the rows are there, the SENTENCES have been removed
 * because the note otherwise did not fit. That is something other than a model that
 * fell over, and the screen must not lump those two together.
 *
 */
export function noteRowsOf(release: { notes?: ReleaseNotes | null } | null | undefined): NoteRows {
    const notes = release?.notes;
    const entities = notes?.entities;
    if (!notes || !Array.isArray(entities)) {
        return { state: 'unrecorded', rows: [], omitted: 0, textsDropped: false };
    }
    return {
        state: 'ok',
        rows: entities.map(noteRow).filter(Boolean) as NoteRow[],
        omitted: countOrNull(notes.omitted) || 0,
        textsDropped: notes.textsDropped === true,
    };
}

/**
 * The rows, grouped by what happened to the entity.
 *
 * `unreadable` counts the rows that fell into no bucket. Such a row is not quietly
 * left out, and also not thrown into `unchanged`: a `change` that this screen does
 * not know is unknown, and unknown narrows to “we could not place this” rather than
 * to “no news”.
 */
export function groupNoteRows(rows: NoteRow[] | null | undefined): NoteGroups {
    const added: NoteRow[] = [];
    const changed: NoteRow[] = [];
    const unchanged: NoteRow[] = [];
    let unreadable = 0;
    for (const row of Array.isArray(rows) ? rows : []) {
        if (row?.change === 'added') added.push(row);
        else if (row?.change === 'changed') changed.push(row);
        else if (row?.change === 'unchanged') unchanged.push(row);
        else unreadable += 1;
    }
    return { added, changed, unchanged, unreadable };
}

/**
 * How often this Solution has been installed — as far as this instance knows.
 *
 * `here` and `elsewhere` are independently unknown: one of the two that could not be
 * read may not be hidden in a total, and certainly not appear as 0. Nor do they ever
 * arrive as anything other than numbers — no project name, no org, no time.
 *
 */
export function readInstalls(remote: ReleaseRemote<InstallsBody> | null | undefined): { state: 'loading' | 'unreadable' | 'ok'; here: number | null; elsewhere: number | null } {
    const status = remote?.status;
    if (status === 'idle' || status === 'loading' || !status) return { state: 'loading', here: null, elsewhere: null };
    if (status !== 'ok') return { state: 'unreadable', here: null, elsewhere: null };

    const body = remote?.data;
    if (!body || typeof body !== 'object') return { state: 'unreadable', here: null, elsewhere: null };

    const here = countOrNull(body.installsHere);
    const elsewhere = countOrNull(body.installsElsewhere);
    // A successful answer in which neither is a number is not a zero.
    if (here === null && elsewhere === null) return { state: 'unreadable', here: null, elsewhere: null };
    return { state: 'ok', here, elsewhere };
}
