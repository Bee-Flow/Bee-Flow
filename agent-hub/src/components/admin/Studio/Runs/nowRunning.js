/**
 * nowRunning — the model behind the "Now running · last 24 hours" strip
 * (Studio.dc.html 1a, Track H2).
 *
 * One line per routine that ran in the window: a coloured dot, the routine's
 * name, one phrase saying where it stands, and how long ago that was. It is
 * drawn from the run FACETS, not from the runs table below it, because the
 * table shows one page and the strip is a claim about the whole window.
 *
 * The facets carry an `automations` rollup — `{ automationId, title, kind,
 * total, status: {status→count}, lastRunAt, lastErrorAt, lastErrorClass }` per
 * routine — which the server builds in the same scan that fills the chips
 * (stores/automationStore/runs.js).
 *
 * ── The rule this file exists to hold ────────────────────────────────────
 *
 * AN UNREADABLE ROLLUP IS NOT AN EMPTY ONE. `readRollups` returns null — not
 * [] — for a facets object that never arrived, failed, or came from a server
 * without the rollup. A strip that draws "nothing is running" over a failed
 * read is the exact shape of mistake this screen is meant to catch: the whole
 * point of it is that a person glances once and believes what they see. So
 * the two states are different values here and different renders in the
 * component, and no branch turns one into the other.
 *
 * THE ERROR SHOWN IS A CLASS, NOT A MESSAGE. `lastErrorClass` says what broke
 * ("a connected app could not be reached"); the free-text error can quote a
 * customer, and in the organisation scope it is somebody else's customer. The
 * message is available one click away, in the run itself, to the person who
 * owns it.
 */

/** How many lines the strip draws before it says "and n more". */
export const NOW_RUNNING_LIMIT = 6;

/** Statuses that mean a run is still going. */
const RUNNING = new Set(['running', 'queued']);
/** Its own set so the tally reads the same way for all three buckets. */
const ERROR_ONLY = new Set(['error']);
/** Statuses that mean a run stopped and is waiting for a person. */
const WAITING = new Set(['awaiting_approval', 'awaiting_confirm', 'awaiting_form']);

/**
 * The four states a routine's window can be in, most urgent first. The index
 * IS the sort rank, so "what needs attention" rises to the top of the strip.
 */
export const NOW_RUNNING_TONES = Object.freeze(['error', 'waiting', 'running', 'done']);

/** Sum the counts of a status map for the statuses in `set`. */
function countIn(statusMap, set) {
    if (!statusMap || typeof statusMap !== 'object') return 0;
    let n = 0;
    for (const [key, value] of Object.entries(statusMap)) {
        if (set.has(String(key)) && Number.isFinite(Number(value))) n += Number(value);
    }
    return n;
}

/**
 * The rollups out of a facets body, or null when there are none to read.
 *
 * Deliberately NOT `facets?.automations || []`. That idiom answers "this
 * organisation had a quiet day" for a request that 403'd, a server that
 * predates the rollup, and a response that arrived truncated — three
 * different things, none of them quiet.
 */
export function readRollups(facets) {
    if (!facets || typeof facets !== 'object' || Array.isArray(facets)) return null;
    if (!Array.isArray(facets.automations)) return null;
    return facets.automations.filter(r => r && typeof r === 'object' && r.automationId);
}

/**
 * One rollup → one strip line.
 *
 * The tone is the most urgent thing that happened in the window, not the most
 * recent: a routine that failed twice this morning and succeeded since is
 * still a routine somebody should look at, and burying that under "done · 38
 * runs" is how a strip like this stops being read.
 */
/** A routine with no usable title reads as nameless, never as "Untitled". */
function titleOf(rollup) {
    return typeof rollup?.title === 'string' && rollup.title.trim() ? rollup.title : null;
}

/** The counts a line is built from, and the tone they add up to. */
function tallyOf(rollup) {
    const errors = countIn(rollup?.status, ERROR_ONLY);
    const waiting = countIn(rollup?.status, WAITING);
    const running = countIn(rollup?.status, RUNNING);
    const tone = errors > 0 ? 'error' : waiting > 0 ? 'waiting' : running > 0 ? 'running' : 'done';
    return { errors, waiting, running, tone };
}

export function toLine(rollup) {
    const total = Number.isFinite(Number(rollup?.total)) ? Number(rollup.total) : 0;
    const { errors, waiting, running, tone } = tallyOf(rollup);
    return {
        automationId: String(rollup.automationId),
        title: titleOf(rollup),
        kind: rollup?.kind === 'block' ? 'block' : 'automation',
        tone,
        total,
        errors,
        waiting,
        running,
        // The class, never the message — see the header.
        errorClass: tone === 'error' && rollup?.lastErrorClass ? String(rollup.lastErrorClass) : null,
        // The moment the line is about: when it last broke if it broke, else
        // when it last ran.
        at: (tone === 'error' ? rollup?.lastErrorAt : null) || rollup?.lastRunAt || null,
    };
}

/**
 * The strip: `{ lines, total, hidden }`, or null when the rollup could not be
 * read (see readRollups). `hidden` is how many routines did not fit — never
 * dropped silently, because "3 routines" and "3 of 40 routines" are different
 * statements about the same organisation.
 */
export function nowRunningLines(facets, { limit = NOW_RUNNING_LIMIT } = {}) {
    const rollups = readRollups(facets);
    if (!rollups) return null;
    const lines = rollups.map(toLine).sort((a, b) => {
        const rank = NOW_RUNNING_TONES.indexOf(a.tone) - NOW_RUNNING_TONES.indexOf(b.tone);
        if (rank !== 0) return rank;
        return String(b.at || '').localeCompare(String(a.at || ''));
    });
    // `automationsTotal` is the server's own count BEFORE its cap, so a busy
    // organisation's "and n more" counts the routines the strip never
    // received, not just the ones it chose not to draw.
    const serverTotal = Number(facets?.automationsTotal);
    const total = Number.isFinite(serverTotal) && serverTotal >= lines.length ? serverTotal : lines.length;
    return { lines: lines.slice(0, limit), total, hidden: Math.max(0, total - Math.min(lines.length, limit)) };
}
