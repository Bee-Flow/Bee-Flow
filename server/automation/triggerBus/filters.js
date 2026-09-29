/**
 * Per-provider trigger filter matchers + pickMatcher registry (§WS5, extracted
 * verbatim from triggerBus.js). Leaf module.
 */

const { matchFilter } = require('../triggers/dslFilters');

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

function containsCI(haystack, needle) {
    if (typeof haystack !== 'string' || typeof needle !== 'string') return false;
    return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * True when `path` is the folder `prefix` itself or lives inside it, with a
 * real path boundary — so an `inFolder: /Invoices` filter matches
 * `/Invoices/x.pdf` and `/Invoices` but NOT the sibling `/InvoicesOld/x.pdf`.
 * `prefix` is expected pre-normalised to a single leading slash and no
 * trailing slash. Matching is case-sensitive (Nextcloud paths are).
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

function matchNextcloudTagFilter(payload, filter) {
    if (!filter) return true;
    // Nextcloud's TagAssignedEvent identifies the tag by numeric id only — it
    // carries no tag name — so `tagId` is the reliable filter. `tagName` is
    // kept for filters saved against the older activity-feed shape, which did
    // include a name.
    if (filter.tagId !== undefined && filter.tagId !== null && filter.tagId !== '') {
        const ids = Array.isArray(payload.tagIds) ? payload.tagIds.map(String) : [];
        if (payload.tagId !== undefined && payload.tagId !== null) ids.push(String(payload.tagId));
        if (!ids.includes(String(filter.tagId))) return false;
    }
    if (filter.tagName && payload.tagName !== filter.tagName) return false;
    if (filter.tagAction && payload.tagAction !== filter.tagAction) return false;
    if (filter.pathPrefix && !(payload.path || '').startsWith(filter.pathPrefix)) return false;
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

function matchNextcloudTablesRowFilter(payload, filter) {
    if (!filter) return true;
    if (filter.tableId !== undefined && filter.tableId !== null && filter.tableId !== ''
        && String(payload.tableId) !== String(filter.tableId)) return false;
    if (filter.actorEquals && payload.actor !== filter.actorEquals) return false;
    // Values are keyed by numeric column id in the event payload (the webhook
    // envelope has no column titles), so a value filter names the column id.
    if (filter.columnId !== undefined && filter.columnId !== null && filter.columnId !== '') {
        const value = payload?.values?.[String(filter.columnId)] ?? payload?.values?.[filter.columnId];
        if (filter.valueEquals !== undefined && String(value ?? '') !== String(filter.valueEquals)) return false;
        if (filter.valueContains && !containsCI(String(value ?? ''), filter.valueContains)) return false;
        // "Only when this column actually changed" — the whole point of
        // watching a status column rather than every edit to the row.
        if (filter.changedOnly) {
            const prev = payload?.previousValues?.[String(filter.columnId)] ?? payload?.previousValues?.[filter.columnId];
            if (payload.previousValues && String(prev ?? '') === String(value ?? '')) return false;
        }
    }
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
    if (filter.calendarId && payload.calendarId !== filter.calendarId) return false;
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
 * meeting-notes.meeting.processed — vuurt zodra een vergadernotitie te lezen is
 * (ingest, herverwerking of een opnieuw gegenereerde samenvatting).
 * Filter: { tags?: string[]|string, reprocessed?: boolean }.
 *
 * ── WAAROM DIT EEN EIGEN MATCHER IS ──────────────────────────────────
 * Zonder deze regel viel het event terug op de ondiepe `matchFilter`, en die
 * doet voor een array-wens `want.includes(got)`. `got` is hier zélf een array
 * (`payload.tags`), dus `['sales'].includes(['sales','klant'])` is false: een
 * tagfilter matchte NOOIT. De trigger stond in de lijst, de subscription stond
 * in de database, en er gebeurde niets — precies de stille variant die alleen
 * als "filter rejected" in een serverlog te zien is.
 *
 * ── DE LEGE TAGFILTER: ELKE afgeronde meeting, niet geen enkele ──────
 * `tags` afwezig, geen array, of een lege lijst = GEEN beperking, dus elke
 * afgeronde vergadernotitie. Vier redenen, in volgorde van gewicht:
 *   1. Zo werkt élk ander filter in dit bestand al: `filter.labelIds`,
 *      `filter.excludeLabelIds` en de DSL-sleutels `any`/`none` kijken
 *      allemaal eerst naar `.length > 0`. Eén filter dat andersom leest,
 *      leert de gebruiker de verkeerde regel voor alle andere.
 *   2. "Ik heb nog geen tag gekozen" en "ik wil er geen enkele" zijn in de
 *      opslag dezelfde waarde, en het tweede vraagt niemand aan een trigger:
 *      wie niets wil, zet de regel uit.
 *   3. Foutsymmetrie. Te breed is luidruchtig (er verschijnen runs, de auteur
 *      versmalt) — te smal is stil (de regel is actief, vuurt nooit, en het
 *      enige spoor is een logregel). Stil verliezen is hier de duurdere fout.
 *   4. Dit is GEEN autorisatiebeslissing, dus "onbekend versmalt" geldt niet:
 *      wie het event mag zien is al beslist door de org-scope van de provider
 *      en door een payload die alleen een id draagt. Dit filter kiest enkel
 *      wélke van de meetings die de abonnee tóch al mag zien een run starten.
 * De UI zegt het met zoveel woorden (triggerFilters.jsx) — de keuze mag geen
 * verborgen aanname zijn.
 *
 * ONLEESBAAR IS IETS ANDERS DAN LEEG. Een payload zonder array in `tags` is
 * een onbekende tagverzameling; daar versmalt het wél, want dan is niet vast
 * te stellen dat er een gevraagde tag bij zit. `emitMeetingProcessed` stuurt
 * altijd een array mee, dus dit raakt alleen een vervormde of oude payload.
 *
 * Vergelijken gaat EXACT en hoofdlettergevoelig — dezelfde regel als de
 * meeting_tag-kennisbron (`kbSources.armMeetingSources`: `config->>'tag' =
 * ANY(...)`). Twee verschillende antwoorden op "heeft deze meeting tag X" is
 * erger dan één streng antwoord. De tags UIT DE PAYLOAD worden daarom NIET
 * genormaliseerd — ook niet getrimd: ' sales' is voor de kennisbron een
 * andere tag dan 'sales' (meetingUsage.js legt vast dat daar nergens
 * genormaliseerd mag worden), en een matcher die hem wél trimt zou de trigger
 * laten vuren op een notitie die de kennisbron niet arm. Alleen wat de AUTEUR
 * in het FILTER typte wordt getrimd — daar is de witruimte een typefout in
 * een formulier, geen gegeven uit een ander systeem.
 *
 * `reprocessed` is DRIEWAARDIG en kan niet aan de ondiepe matcher worden
 * overgelaten: de payload láát de sleutel weg bij een eerste ingest, dus
 * `{reprocessed:false}` betekende daar `undefined !== false` → nooit. Hier:
 * weglaten = alle drie de aanleidingen, `false` = alleen een eerste ingest,
 * `true` = alleen een herverwerking of nieuwe samenvatting.
 *
 * Uitsluiten hoeft geen eigen sleutel: de DSL doet dat al met
 * `none: [{ tags: ['vertrouwelijk'] }]` bovenop deze matcher.
 */
function asTagList(v) {
    const raw = Array.isArray(v) ? v : (typeof v === 'string' ? [v] : []);
    return raw.map(t => (typeof t === 'string' ? t.trim() : '')).filter(Boolean);
}

/**
 * Een sleutel telt alleen als "door mij beantwoord" wanneer de WAARDE een vorm
 * heeft die deze matcher kan lezen. `tags: {any:[…]}` is geen lege tagwens,
 * het is een ONLEESBARE — die hoort niet stilzwijgend te verdwijnen maar door
 * te lopen naar `matchFilter`, waar hij versmalt.
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

    // ── ONBEKEND VERSMALT, OOK HIER ──────────────────────────────────
    // Een sleutel die deze matcher niet kent is GEEN vrijbrief. Zonder deze
    // laatste stap betekende `{tagIncludes:'sales'}` — een vorm die in het
    // wild voorkomt (core/meetingNotes/meetingUsage.js noemt hem met naam) —
    // "elke afgeronde vergadernotitie": leeg-is-alles plus genegeerde
    // sleutels is samen fail-open. Vóór deze matcher deed de ondiepe
    // `matchFilter` het omgekeerde (zulke filters vuurden nooit), dus zonder
    // dit klapt een al opgeslagen routine stil van "nooit" naar "altijd".
    // Ook de spiegelkant telt: in `none: [{ tagIncludes: 'geheim' }]` moet de
    // submatcher NEE kunnen zeggen, anders sluit die clausule alles uit.
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

function pickMatcher(provider, event) {
    if (provider === 'support' && event === 'ticket.resolved') return matchSupportTicketResolvedFilter;
    if (provider === 'meeting-notes' && event === 'meeting.processed') return matchMeetingProcessedFilter;
    if (provider === 'gmail' && event === 'mail.new') return matchGmailMailFilter;
    if (provider === 'gmail' && event === 'label.added') return matchGmailLabelFilter;
    if (provider === 'google-calendar' && event === 'event.changed')  return matchCalendarChangedFilter;
    if (provider === 'google-calendar' && event === 'event.upcoming') return matchCalendarUpcomingFilter;
    if (provider === 'google-drive' && event === 'file.new')          return matchDriveFileNewFilter;
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
    return matchFilter;
}

module.exports = { matchGmailMailFilter, matchGmailLabelFilter, matchCalendarChangedFilter, matchCalendarUpcomingFilter, matchDriveFileNewFilter, matchNextcloudFileFilter, matchNextcloudShareFilter, matchNextcloudShareGenericFilter, matchNextcloudActivityFilter, matchNextcloudNotificationFilter, matchNextcloudCommentFilter, matchNextcloudTagFilter, matchNextcloudFormsSubmittedFilter, matchNextcloudTablesRowFilter, matchSupportTicketResolvedFilter, matchMeetingProcessedFilter, matchNextcloudCalendarFilter, matchNextcloudCalendarUpcomingFilter, matchNextcloudDeckCardFilter, matchNextcloudDeckCardMovedFilter, matchNextcloudTalkMessageFilter, matchNextcloudTalkReactionFilter, matchNextcloudTaskFilter, matchNextcloudUserStatusFilter, containsCI, pickMatcher };
