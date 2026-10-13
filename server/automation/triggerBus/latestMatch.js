/**
 * Latest-match lookups that seed manual runs, activation and trigger
 * simulation with a real payload. Extracted verbatim from ../triggerBus.js.
 *
 * `ctx` is the object triggerBus.js builds: `store()` returns the current
 * automationStore (swappable through triggerBus._setDepsForTests), the other
 * getters return the client / integration modules, required lazily as they
 * were inline. Everything that sits in the server's import cycle comes in
 * through it, so this module stays a leaf.
 */

const { applyDslFilter } = require('../triggers/dslFilters');
const { matchGmailMailFilter, pickMatcher } = require('./filters');
const { fetchGmailMessageMetadata } = require('./pollers/gmail');
const { _ncFetchActivityRows, _ncNormaliseActivity } = require('./pollers/nextcloud');
const log = require('../../telemetry/log');

/**
 * Find the most recent Gmail message that matches a mail.new filter and
 * return it shaped like a regular trigger payload. Used by:
 *   - manual run of a Gmail-triggered automation, so the user gets a
 *     real test against actual inbox content instead of a null payload.
 *   - activate, so flipping the toggle immediately processes the latest
 *     matching email rather than only firing on subsequent arrivals.
 *
 * Returns null if no message matches (or if the user has no Gmail tokens).
 * The caller decides what to do with that — typically: skip dispatch and
 * let the run record an explanatory error.
 *
 * Filter is applied client-side via matchGmailMailFilter so the semantics
 * are identical to the polling path (case-insensitive, system-label aware,
 * fail-closed regex). Server-side `q` is used only as a coarse pre-filter
 * to keep the API call cheap.
 */
async function fetchLatestGmailMatch(ctx, userId, filter) {
    try {
        const session = await ctx.loadSession(userId);
        if (!session?.accessToken) return null;
        const { createGoogleApiClient } = ctx.googleClient();
        const gmail = await createGoogleApiClient(session, { api: 'gmail', version: 'v1' });

        // Coarse server-side narrowing. Only fields Gmail's `q` understands
        // get pre-filtered; the rest (regex, exclude labels, freshness, ...)
        // are caught by the client-side matcher.
        const q = [];
        if (filter?.from) q.push(`from:${filter.from}`);
        if (filter?.to) q.push(`to:${filter.to}`);
        if (filter?.subjectContains) q.push(`subject:${JSON.stringify(filter.subjectContains)}`);
        if (filter?.hasAttachment === true) q.push('has:attachment');
        if (filter?.excludeFromSelf === true) q.push('-in:sent');
        // We sort by recency by default; cap to 10 candidates so a popular
        // sender can't make us page through hundreds of messages just to
        // find one that passes the regex/freshness filter.
        const list = await gmail.users.messages.list({
            userId: 'me',
            q: q.join(' ') || undefined,
            maxResults: 10,
        });
        const ids = (list.data.messages || []).map(m => m.id).filter(Boolean);
        if (ids.length === 0) return null;

        for (const id of ids) {
            const meta = await fetchGmailMessageMetadata(ctx, gmail, id).catch(() => null);
            if (!meta) continue;
            const payload = { messageId: id, threadId: list.data.messages.find(m => m.id === id)?.threadId || null, ...meta };
            if (matchGmailMailFilter(payload, filter || null)) return payload;
        }
        return null;
    } catch (e) {
        log.warn(`[TriggerBus] fetchLatestGmailMatch failed for user ${userId}: ${e.message}`);
        return null;
    }
}

/**
 * Find the most recent Nextcloud activity that matches an automation's trigger,
 * shaped as the trigger payload. Used to seed MANUAL runs and trigger
 * simulation for NC-triggered automations — without this an NC automation run
 * by hand gets `triggerPayload=null`, so `trigger.output.path` is undefined and
 * the first NC action fails with "path is required" (the "Sort Invoices" bug).
 * Mirrors fetchLatestGmailMatch. Returns null when nothing matches.
 */
async function fetchLatestNextcloudMatch(ctx, userId, event, filter) {
    try {
        const session = await ctx.loadSession(userId);
        if (!session) return null;
        const rows = await _ncFetchActivityRows(ctx, userId, session);
        if (!rows || !rows.length) return null;
        const baseMatcher = pickMatcher('nextcloud', event);
        // Newest first so a manual run binds against the latest matching item.
        const sorted = rows.slice().sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
        for (const row of sorted) {
            const payload = _ncNormaliseActivity(row, session);
            const ok = baseMatcher ? applyDslFilter(payload, filter || null, baseMatcher) : true;
            if (ok) return payload;
        }
        return null;
    } catch (e) {
        log.warn(`[TriggerBus] fetchLatestNextcloudMatch failed for user ${userId}: ${e.message}`);
        return null;
    }
}

module.exports = { fetchLatestGmailMatch, fetchLatestNextcloudMatch };
