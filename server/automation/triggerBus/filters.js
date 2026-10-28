// @typecheck
/**
 * Per-provider trigger filter matchers + pickMatcher registry (§WS5, extracted
 * verbatim from triggerBus.js). Leaf module.
 */

const { matchFilter } = require('../triggers/dslFilters');
const { containsCI } = require('./matchUtil');
const { matchNextcloudTablesRowFilter } = require('./filtersTables');
const { matchNextcloudTagFilter, tagFilterNeedsNames } = require('./filtersNcTags');

function matchGmailMailFilter(payload, filter) {
    if (!filter || typeof filter !== 'object') return true;
    if (!payload || typeof payload !== 'object') return false;

    const containsCI = (haystack, needle) => {
        if (typeof haystack !== 'string' || typeof needle !== 'string') return false;
        return haystack.toLowerCase().includes(needle.toLowerCase());
    };

    if (typeof filter.from === 'string' && filter.from && !containsCI(payload.from, filter.from)) return false;
    if (typeof filter.to === 'string' && filter.to && !containsCI(payload.to, filter.to)) return false;
    if (typeof filter.cc === 'string' && filter.cc && !containsCI(payload.cc, filter.cc)) return false;

    if (typeof filter.subjectContains === 'string' && filter.subjectContains && !containsCI(payload.subject, filter.subjectContains)) return false;

    if (typeof filter.subjectRegex === 'string' && filter.subjectRegex) {
        const src = filter.subjectRegex.slice(0, 200);
        try {
            const re = new RegExp(src, 'i');
            if (!re.test(String(payload.subject || ''))) return false;
        } catch {
            // Invalid pattern → fail-closed (don't fire) so a typo
            // can't quietly match every email.
            return false;
        }
    }

    const labelIds = Array.isArray(payload.labelIds) ? payload.labelIds : [];
    if (Array.isArray(filter.labelIds) && filter.labelIds.length > 0) {
        if (!filter.labelIds.some(id => labelIds.includes(id))) return false;
    }
    if (Array.isArray(filter.excludeLabelIds) && filter.excludeLabelIds.length > 0) {
        if (filter.excludeLabelIds.some(id => labelIds.includes(id))) return false;
    }
    if (filter.hasAttachment === true) {
        // Prefer the explicit attachments[] populated by fetchGmailMessageMetadata
        // (definitive) and fall back to the HAS_ATTACHMENT system label so
        // older payloads (e.g. from the live-watcher diff path that hasn't been
        // enriched yet) still work.
        const hasExplicit = Array.isArray(payload.attachments) && payload.attachments.length > 0;
        if (!hasExplicit && !labelIds.includes('HAS_ATTACHMENT')) return false;
    }
    if (filter.excludeFromSelf === true) {
        if (labelIds.includes('SENT')) return false;
    }

    if (typeof filter.maxAgeMinutes === 'number' && filter.maxAgeMinutes > 0 && payload.date) {
        const t = Date.parse(payload.date);
        if (!Number.isFinite(t)) return false;
        const ageMin = (Date.now() - t) / 60_000;
        if (ageMin > filter.maxAgeMinutes) return false;
    }

    return true;
}

// ── Per-trigger matchers ───────────────────────────────────────────────
//
// Each matcher is a pure function `(payload, filter) → boolean`. They share
// these conventions with `matchGmailMailFilter`:
//   - undefined/empty filter → always pass.
//   - unknown filter keys are ignored (forward-compatible).
//   - regex fields are capped at 200 chars and fail-closed on parse error.
//   - case-insensitive substring is the default for free-text fields.

/**
 * True when `path` is the folder `prefix` itself or lives inside it, with a
 * real path boundary — so an `inFolder: /Invoices` filter matches
 * `/Invoices/x.pdf` and `/Invoices` but NOT the sibling `/InvoicesOld/x.pdf`.
 * `prefix` is expected pre-normalised to a single leading slash and no
 * trailing slash. Matching is case-sensitive (Nextcloud paths are).
 * @param {string} path
 * @param {string} prefix
 */
function isPathInFolder(path, prefix) {
    if (typeof path !== 'string') return false;
    if (path === prefix) return true;
    return path.startsWith(prefix + '/');
}

/**
 * gmail.label.added — fires when a label is applied to a message.
 * Filter: { labelId (required), from?, subjectContains?, excludeLabelIds? }.
 */
function matchGmailLabelFilter(payload, filter) {
    if (!filter || typeof filter !== 'object') return true;
    if (!payload) return false;
    const added = Array.isArray(payload.addedLabelIds) ? payload.addedLabelIds : [];
    if (filter.labelId && !added.includes(filter.labelId)) return false;
    if (filter.from && !containsCI(payload.from, filter.from)) return false;
    if (filter.subjectContains && !containsCI(payload.subject, filter.subjectContains)) return false;
    if (Array.isArray(filter.excludeLabelIds) && filter.excludeLabelIds.length) {
        const all = Array.isArray(payload.labelIds) ? payload.labelIds : [];
        if (filter.excludeLabelIds.some(id => all.includes(id))) return false;
    }
    return true;
}

/**
 * google-calendar.event.changed — fires when the syncToken poller surfaces
 * an event mutation. Filter: { calendarId?, statusEquals?, attendeeEmailContains? }.
 */
function matchCalendarChangedFilter(payload, filter) {
    if (!filter || typeof filter !== 'object') return true;
    if (!payload) return false;
    if (filter.calendarId && payload.calendarId && payload.calendarId !== filter.calendarId) return false;
    if (filter.statusEquals && payload.status !== filter.statusEquals) return false;
    if (filter.attendeeEmailContains) {
        const ats = Array.isArray(payload.attendees) ? payload.attendees : [];
        if (!ats.some(a => containsCI(a?.email || '', filter.attendeeEmailContains))) return false;
    }
    return true;
}

/**
 * google-calendar.event.upcoming — server-side already filtered to the
 * leadMinutes window so the matcher is effectively a passthrough; we still
 * honour calendarId / attendee filters for users whose `events.list` query
 * spans multiple calendars (calendarId='primary' default).
 */
function matchCalendarUpcomingFilter(payload, filter) {
    return matchCalendarChangedFilter(payload, filter);
}

/**
 * google-drive.file.new — fires when a new file appears in changes.list.
 * Filter: { folderId?, mimeType?, nameContains?, excludeOwnUploads? }.
 */
function matchDriveFileNewFilter(payload, filter) {
    if (!filter || typeof filter !== 'object') return true;
    if (!payload) return false;
    if (filter.folderId) {
        const parents = Array.isArray(payload.parents) ? payload.parents : [];
        if (!parents.includes(filter.folderId)) return false;
    }
    if (filter.mimeType && payload.mimeType !== filter.mimeType) return false;
    if (filter.nameContains && !containsCI(payload.name, filter.nameContains)) return false;
    if (filter.excludeOwnUploads === true) {
        const owners = Array.isArray(payload.owners) ? payload.owners : [];
        if (owners.some(o => o?.me === true)) return false;
    }
    return true;
}

/**
 * nextcloud.file.new / nextcloud.file.changed — shared filter shape.
 * Filter: { inFolder?, extension?, nameContains?, excludeOwnUploads? }.
 */
function matchNextcloudFileFilter(payload, filter) {
    if (!filter || typeof filter !== 'object') return true;
    if (!payload) return false;
    const path = String(payload.path || payload.objectName || '');
    if (filter.inFolder) {
        // Normalise to a single leading slash, no trailing slash.
        const prefix = `/${String(filter.inFolder).replace(/^\/+/, '').replace(/\/+$/, '')}`;
        if (prefix !== '/' && !isPathInFolder(path, prefix)) return false;
    }
    if (filter.extension) {
        const want = String(filter.extension).replace(/^\./, '').toLowerCase();
        const got = path.split('.').pop()?.toLowerCase();
        if (want && got !== want) return false;
    }
    if (filter.nameContains && !containsCI(payload.name || path.split('/').pop() || '', filter.nameContains)) return false;
    if (filter.excludeOwnUploads === true) {
        // Activity feed actor is the user who performed the action; the
        // poller stamps `payload.isOwnAction` based on the session uid.
        if (payload.isOwnAction === true) return false;
    }
    return true;
}

/**
 * nextcloud.share.received — Filter: { actorEquals?, nameContains?, kindEquals? }.
 */
function matchNextcloudShareFilter(payload, filter) {
    if (!filter || typeof filter !== 'object') return true;
    if (!payload) return false;
    if (filter.actorEquals && payload.actor !== filter.actorEquals) return false;
    if (filter.nameContains && !containsCI(payload.name || payload.objectName || '', filter.nameContains)) return false;
    if (filter.kindEquals && payload.kind !== filter.kindEquals) return false;
    return true;
}

/**
 * nextcloud.activity.new — power-user catch-all.
 * Filter: { type?, objectNameContains?, actorEquals? }.
 */
function matchNextcloudActivityFilter(payload, filter) {
    if (!filter || typeof filter !== 'object') return true;
    if (!payload) return false;
    if (filter.type && payload.type !== filter.type) return false;
    if (filter.objectNameContains && !containsCI(payload.objectName || '', filter.objectNameContains)) return false;
    if (filter.actorEquals && payload.actor !== filter.actorEquals) return false;
    return true;
}

/**
 * nextcloud.notification.new — Filter: { app?, subjectContains? }.
 */
function matchNextcloudNotificationFilter(payload, filter) {
    if (!filter || typeof filter !== 'object') return true;
    if (!payload) return false;
    if (filter.app && payload.app !== filter.app) return false;
    if (filter.subjectContains && !containsCI(payload.subject || '', filter.subjectContains)) return false;
    return true;
}

// ── Rich filter DSL (Phase 1.4) ──────────────────────────────────────
//
// Power-Automate-style filter combinators that work on top of any
// per-provider matcher. The structured fields (filter.from / filter.path
// / filter.calendarId / …) keep their existing semantics; the DSL keys
// add boolean composition + expressions:
//
//   filter: {
//     any:  [{ pathPrefix: "/Invoices/" }, { pathPrefix: "/Receipts/" }],
//     none: [{ extension: "tmp" }],
//     expr: "trigger.size > 1024 * 1024",
//     age:  { olderThanMinutes: 60, newerThanMinutes: 5 },
//     ...rest of structured fields evaluated by the per-event matcher
//   }
//
// ── Phase 1.3 matchers — new Nextcloud trigger types ─────────────────

function matchNextcloudCommentFilter(payload, filter) {
    if (!filter) return true;
    if (filter.pathPrefix && !(payload.path || '').startsWith(filter.pathPrefix)) return false;
    if (filter.actorEquals && payload.actor !== filter.actorEquals) return false;
    if (filter.messageContains && !containsCI(payload.comment, filter.messageContains)) return false;
    return true;
}

function matchNextcloudFormsSubmittedFilter(payload, filter) {
    if (!filter) return true;
    if (filter.formId !== undefined && filter.formId !== null && filter.formId !== ''
        && String(payload.formId) !== String(filter.formId)) return false;
    if (filter.formHash && payload.formHash !== filter.formHash) return false;
    if (filter.titleContains && !containsCI(payload.formTitle, filter.titleContains)) return false;
    if (filter.submittedByEquals && payload.submittedBy !== filter.submittedByEquals) return false;
    return true;
}

function matchNextcloudShareGenericFilter(payload, filter) {
    if (!filter) return true;
    if (filter.actorEquals && payload.actor !== filter.actorEquals) return false;
    if (filter.nameContains && !containsCI(payload.name, filter.nameContains)) return false;
    if (filter.kindEquals && payload.kind !== filter.kindEquals) return false;
    if (filter.shareType && payload.shareType !== filter.shareType) return false;
    return true;
}

function matchNextcloudCalendarFilter(payload, filter) {
    if (!filter) return true;
    // The webhook carries the numeric calendar id, the poller the URI form
    // ("personal"): a filter value naming either one matches.
    if (filter.calendarId && String(payload.calendarId) !== String(filter.calendarId)
        && String(payload.calendarUri) !== String(filter.calendarId)) return false;
    if (filter.calendarUri && String(payload.calendarUri) !== String(filter.calendarUri)) return false;
    if (filter.summaryContains && !containsCI(payload.summary, filter.summaryContains)) return false;
    if (filter.attendeeContains) {
        const attendees = Array.isArray(payload.attendees) ? payload.attendees.join(' ') : (payload.attendees || '');
        if (!containsCI(attendees, filter.attendeeContains)) return false;
    }
    return true;
}

function matchNextcloudCalendarUpcomingFilter(payload, filter) {
    if (!matchNextcloudCalendarFilter(payload, filter)) return false;
    if (filter && typeof filter.leadMinutes === 'number') {
        const start = payload?.startsAt ? Date.parse(payload.startsAt) : NaN;
        if (Number.isFinite(start)) {
            const minutesUntil = (start - Date.now()) / 60_000;
            // Trigger fires when minutesUntil ≤ leadMinutes (and still future)
            if (minutesUntil < 0 || minutesUntil > filter.leadMinutes) return false;
        }
    }
    return true;
}

function matchNextcloudDeckCardFilter(payload, filter) {
    if (!filter) return true;
    if (filter.boardId && String(payload.boardId) !== String(filter.boardId)) return false;
    if (filter.stackId && String(payload.stackId) !== String(filter.stackId)) return false;
    if (filter.titleContains && !containsCI(payload.title, filter.titleContains)) return false;
    if (typeof filter.archived === 'boolean' && !!payload.archived !== filter.archived) return false;
    return true;
}

function matchNextcloudDeckCardMovedFilter(payload, filter) {
    if (!matchNextcloudDeckCardFilter(payload, filter)) return false;
    // The payload never carries fromStackId/toStackId: the connector
    // publishes the card's CURRENT stack as `stackId` and the one it left as
    // `previousStackId` (triggerSources/declared/nextcloud.js). Until
    // 2026-09-17 this read the filter's own key names off the payload, so a
    // filter with either key never matched a single move.
    if (filter && filter.fromStackId && String(payload.previousStackId) !== String(filter.fromStackId)) return false;
    if (filter && filter.toStackId && String(payload.stackId) !== String(filter.toStackId)) return false;
    return true;
}

function matchNextcloudTalkMessageFilter(payload, filter) {
    if (!filter) return true;
    if (filter.roomToken && payload.roomToken !== filter.roomToken) return false;
    if (filter.roomNameContains && !containsCI(payload.roomName, filter.roomNameContains)) return false;
    if (filter.actorEquals && payload.actor !== filter.actorEquals) return false;
    if (filter.messageContains && !containsCI(payload.message, filter.messageContains)) return false;
    if (filter.excludeOwnMessages && payload.isOwn === true) return false;
    return true;
}

function matchNextcloudTalkReactionFilter(payload, filter) {
    if (!filter) return true;
    if (filter.roomToken && payload.roomToken !== filter.roomToken) return false;
    if (filter.roomNameContains && !containsCI(payload.roomName, filter.roomNameContains)) return false;
    if (filter.actorEquals && payload.actor !== filter.actorEquals) return false;
    if (filter.reaction && payload.reaction !== filter.reaction) return false;
    // Reactions fire on both add and remove. Default to adds only — "when
    // someone thumbs-up my message" almost never means "…or takes it back".
    const wantRemoved = filter.includeRemoved === true;
    if (!wantRemoved && payload.removed === true) return false;
    return true;
}

function matchNextcloudTaskFilter(payload, filter) {
    if (!filter) return true;
    if (filter.listId && String(payload.listId) !== String(filter.listId)) return false;
    if (filter.titleContains && !containsCI(payload.title, filter.titleContains)) return false;
    if (filter.priorityEquals && payload.priority !== filter.priorityEquals) return false;
    return true;
}

function matchNextcloudUserStatusFilter(payload, filter) {
    if (!filter) return true;
    if (filter.status && payload.status !== filter.status) return false;
    if (filter.userIdEquals && payload.userId !== filter.userIdEquals) return false;
    return true;
}

/**
 * google-sheets.spreadsheet.changed / spreadsheet.new — Filter:
 * { spreadsheetId?, nameContains? }.
 *
 * The narrow case is mostly decided BEFORE dispatch: a subscription that picks
 * a spreadsheet polls its contents directly (the declaration's contentWatch
 * variant), and sheet/range narrowing happens in that call. This matcher is
 * the backstop — file-level subscriptions still filter on the file id, and a
 * content payload echoes its spreadsheetId, so both shapes land here.
 */
function matchSheetsChangedFilter(payload, filter) {
    if (!filter || typeof filter !== 'object') return true;
    if (!payload) return false;
    if (filter.spreadsheetId) {
        const id = payload.spreadsheetId || payload.id;
        if (String(id || '') !== String(filter.spreadsheetId)) return false;
    }
    if (filter.nameContains && !containsCI(payload.name || '', filter.nameContains)) return false;
    return true;
}

/**
 * Picks the right matcher for a (provider, event) pair. Falls back to the
 * shallow `matchFilter` for anything we haven't taught explicit semantics
 * — keeps webhook providers (msgraph, github) working unchanged.
 */
/**
 * support.ticket.resolved — fires when a tenant Support-inbox ticket is resolved.
 * Filter: { inboxId?, categoryEquals?, priorityEquals?, resolvedBy? ('ai'|'staff'),
 *           tagIncludes?, minMessages?, requireGenuineContact? }.
 * `requireGenuineContact` defaults to true: a resolved ticket only matches when
 * the dispatcher stamped `genuineContact:true` (a real customer↔agent exchange
 * with a sent reply). Set it false to also ingest non-customer-contact threads.
 */
function matchSupportTicketResolvedFilter(payload, filter) {
    const f = (filter && typeof filter === 'object') ? filter : {};
    if (!payload) return false;
    if (f.inboxId && payload.inboxId !== f.inboxId) return false;
    if (f.categoryEquals && payload.category !== f.categoryEquals) return false;
    if (f.priorityEquals && payload.priority !== f.priorityEquals) return false;
    if (f.resolvedBy && payload.resolvedBy !== f.resolvedBy) return false;
    if (f.tagIncludes && !(Array.isArray(payload.tags) && payload.tags.includes(f.tagIncludes))) return false;
    if (typeof f.minMessages === 'number' && (payload.messageCount || 0) < f.minMessages) return false;
    // Genuine customer contact required by default — belt-and-suspenders with the
    // dispatch-time gate (which already skips emit when contact isn't genuine).
    if (f.requireGenuineContact !== false && payload.genuineContact !== true) return false;
    return true;
}

/**
 * meeting-notes.meeting.processed — fires as soon as a meeting note is readable (ingest, reprocessing or a
 * regenerated summary). Filter: { tags?: string[]|string, reprocessed?: boolean }.
 *
 * ── WHY THIS IS ITS OWN MATCHER ──────────────────────────────────────
 * Without this rule the event fell back to the shallow `matchFilter`, and that does, for a wish that is an
 * array, `want.includes(got)`. `got` is itself an array here (`payload.tags`), so
 * `['sales'].includes(['sales','klant'])` is false: a tag filter NEVER matched. The trigger was in the list,
 * the subscription was in the database, and nothing happened — precisely the silent variant that only shows up
 * as "filter rejected" in a server log.
 *
 * ── THE EMPTY TAG FILTER: EVERY completed meeting, not none at all ──
 * `tags` absent, not an array, or an empty list = NO restriction, so every completed meeting note. Four reasons,
 * in order of weight:
 *   1. That is how every other filter in this file already works: `filter.labelIds`, `filter.excludeLabelIds`
 *      and the DSL keys `any`/`none` all look first at `.length > 0`. A filter that reads the other way round
 *      teaches the user the wrong rule for all the others.
 *   2. "I have not chosen a tag yet" and "I want none at all" are the same value in storage, and the second is
 *      something nobody asks of a trigger: whoever wants nothing switches the rule off.
 *   3. Error symmetry. Too broad is loud (runs appear, the author narrows) — too narrow is silent (the rule is
 *      active, never fires, and the only trace is a log line). Silently losing is the more expensive mistake here.
 *   4. This is NOT an authorisation decision, so "unknown narrows" does not apply: who may see the event is already
 *      decided by the org scope of the provider and by a payload that carries only an id. This filter merely
 *      chooses WHICH of the meetings that the subscriber may already see starts a run.
 * The UI says so explicitly (triggerFilters.jsx) — the choice must not be a hidden assumption.
 *
 * UNREADABLE IS SOMETHING OTHER THAN EMPTY. A payload without an array in `tags` is an unknown tag set; there
 * narrowing does apply, because it cannot be established that a requested tag is among them. `emitMeetingProcessed`
 * always sends an array along, so this only touches a distorted or old payload.
 *
 * Comparison is EXACT and case-sensitive — the same rule as the meeting_tag knowledge source
 * (`kbSources.armMeetingSources`: `config->>'tag' = ANY(...)`). Two different answers to "does this meeting have
 * tag X" is worse than one strict answer. The tags FROM THE PAYLOAD are therefore NOT normalised — not trimmed
 * either: ' sales' is for the knowledge source a different tag from 'sales' (meetingUsage.js records that nothing
 * there may be normalised), and a matcher that did trim it would let the trigger fire on a note that the
 * knowledge source does not tag. Only what the AUTHOR typed in the FILTER is trimmed — there the whitespace is a
 * typo in a form, not data from another system.
 *
 * `reprocessed` is THREE-VALUED and cannot be left to the shallow matcher: the payload omits the key on a first
 * ingest, so `{reprocessed:false}` there meant `undefined !== false` → never. Here: omitted = all three triggers,
 * `false` = only a first ingest, `true` = only a reprocessing or a new summary.
 *
 * Excluding needs no key of its own: the DSL already does that with `none: [{ tags: ['vertrouwelijk'] }]` on top
 * of this matcher.
 */
function asTagList(v) {
    const raw = Array.isArray(v) ? v : (typeof v === 'string' ? [v] : []);
    return raw.map(t => (typeof t === 'string' ? t.trim() : '')).filter(Boolean);
}

/**
 * A key counts as "answered by me" only when the VALUE has a shape that this matcher can read. `tags: {any:[…]}`
 * is not an empty tag wish, it is an UNREADABLE one — that should not silently disappear but should pass through
 * to `matchFilter`, where it narrows.
 * @param {string} key
 */
function meetingKeyIsReadable(key, value) {
    if (key === 'tags') return Array.isArray(value) || typeof value === 'string';
    if (key === 'reprocessed') return value === true || value === false;
    return false;
}

function matchMeetingProcessedFilter(payload, filter) {
    const f = (filter && typeof filter === 'object') ? filter : {};
    if (!payload) return false;

    const wanted = meetingKeyIsReadable('tags', f.tags) ? asTagList(f.tags) : [];
    if (wanted.length > 0) {
        // null = onleesbaar (geen array), [] = leesbaar en leeg.
        const got = Array.isArray(payload.tags)
            ? payload.tags.filter(t => typeof t === 'string' && t.trim())
            : null;
        if (!got || !wanted.some(t => got.includes(t))) return false;
    }

    if (f.reprocessed === true && payload.reprocessed !== true) return false;
    if (f.reprocessed === false && payload.reprocessed === true) return false;

    // ── UNKNOWN NARROWS, HERE TOO ──────────────────────────────────
    // A key that this matcher does not know is NO blank cheque. Without this last step, `{tagIncludes:'sales'}` —
    // a shape that occurs in the wild (core/meetingNotes/meetingUsage.js names it explicitly) — would mean "every
    // completed meeting note": empty-means-everything plus ignored keys is together fail-open. The
    // shallow `matchFilter` does the opposite (such filters never fire), so without this an automation that
    // has already been stored would silently flip from "never" to "always".
    // The mirror side counts too: in `none: [{ tagIncludes: 'geheim' }]` the submatcher must be able to say NO,
    // otherwise that clause excludes everything.
    const rest = {};
    let hasRest = false;
    for (const key of Object.keys(f)) {
        if (f[key] === undefined) continue;
        if (meetingKeyIsReadable(key, f[key])) continue;
        rest[key] = f[key];
        hasRest = true;
    }
    if (hasRest && !matchFilter(payload, rest)) return false;

    return true;
}

/**
 * @param {string} provider
 * @param {string} event
 */
function pickMatcher(provider, event) {
    if (provider === 'support' && event === 'ticket.resolved') return matchSupportTicketResolvedFilter;
    if (provider === 'meeting-notes' && event === 'meeting.processed') return matchMeetingProcessedFilter;
    if (provider === 'gmail' && event === 'mail.new') return matchGmailMailFilter;
    if (provider === 'gmail' && event === 'label.added') return matchGmailLabelFilter;
    if (provider === 'google-calendar' && event === 'event.changed')  return matchCalendarChangedFilter;
    if (provider === 'google-calendar' && event === 'event.upcoming') return matchCalendarUpcomingFilter;
    if (provider === 'google-drive' && event === 'file.new')          return matchDriveFileNewFilter;
    if (provider === 'google-sheets'
        && (event === 'spreadsheet.changed' || event === 'spreadsheet.new')) return matchSheetsChangedFilter;
    if (provider === 'nextcloud') {
        // File family — share semantics same shape but slightly different fields.
        if (event === 'file.new' || event === 'file.changed' || event === 'file.deleted' || event === 'file.renamed') return matchNextcloudFileFilter;
        if (event === 'file.commented')   return matchNextcloudCommentFilter;
        if (event === 'file.tagged' || event === 'file.untagged') return matchNextcloudTagFilter;
        // Forms / Tables
        if (event === 'forms.submitted')  return matchNextcloudFormsSubmittedFilter;
        if (event === 'tables.row.added' || event === 'tables.row.updated' || event === 'tables.row.deleted')
            return matchNextcloudTablesRowFilter;
        // Share family — share.received is the legacy "you got shared" event.
        if (event === 'share.received')   return matchNextcloudShareFilter;
        if (event === 'share.created' || event === 'share.accepted' || event === 'share.deleted')
            return matchNextcloudShareGenericFilter;
        // Calendar
        if (event === 'calendar.event.upcoming') return matchNextcloudCalendarUpcomingFilter;
        if (event === 'calendar.event.created' || event === 'calendar.event.changed' || event === 'calendar.event.deleted')
            return matchNextcloudCalendarFilter;
        // Deck
        if (event === 'deck.card.moved')   return matchNextcloudDeckCardMovedFilter;
        if (event === 'deck.card.created' || event === 'deck.card.changed' || event === 'deck.card.deleted' || event === 'deck.card.completed')
            return matchNextcloudDeckCardFilter;
        // Talk
        if (event === 'talk.message.received' || event === 'talk.mention.received')
            return matchNextcloudTalkMessageFilter;
        if (event === 'talk.reaction.added') return matchNextcloudTalkReactionFilter;
        // Tasks
        if (event === 'task.created' || event === 'task.completed' || event === 'task.due')
            return matchNextcloudTaskFilter;
        // Generic
        if (event === 'activity.new')      return matchNextcloudActivityFilter;
        if (event === 'notification.new')  return matchNextcloudNotificationFilter;
        if (event === 'user.status.changed') return matchNextcloudUserStatusFilter;
    }
    return provider === 'msgraph' && event === 'mail.new' ? require('./filtersMsGraph').matchMsGraphMailFilter : matchFilter;
}

module.exports = { matchGmailMailFilter, matchGmailLabelFilter, matchCalendarChangedFilter, matchCalendarUpcomingFilter, matchDriveFileNewFilter, matchSheetsChangedFilter, matchNextcloudFileFilter, matchNextcloudShareFilter, matchNextcloudShareGenericFilter, matchNextcloudActivityFilter, matchNextcloudNotificationFilter, matchNextcloudCommentFilter, matchNextcloudTagFilter, matchNextcloudFormsSubmittedFilter, matchNextcloudTablesRowFilter, matchSupportTicketResolvedFilter, matchMeetingProcessedFilter, matchNextcloudCalendarFilter, matchNextcloudCalendarUpcomingFilter, matchNextcloudDeckCardFilter, matchNextcloudDeckCardMovedFilter, matchNextcloudTalkMessageFilter, matchNextcloudTalkReactionFilter, matchNextcloudTaskFilter, matchNextcloudUserStatusFilter, containsCI, pickMatcher, tagFilterNeedsNames };

/** @typedef {Record<string, any>} TriggerPayload  an event payload: loose provider JSON, shape differs per provider */

/** @typedef {Record<string, any>} TriggerFilter  a trigger's filter as authored: loose JSON, keys differ per event */
