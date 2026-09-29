/**
 * The `mailbox` connector kind — a Gmail/Outlook mailbox as an app data source.
 *
 * Emits two grains so the existing sync machinery does the rest:
 *   grain 0 — messages     → the connector's `sync.tableId`
 *   grain 1 — attachments  → `sync.children[0]`, related back by `_parentIndex`
 *
 * Idempotency is NOT bespoke: `sync.mode:'upsert'` on `provider_message_id`,
 * backed by a UNIQUE index on that column, is the equivalent of the support
 * inbox's `uq_support_messages_provider_msg`. Combined with the overlap window
 * in services/email/fetch.js, re-listing the same message is a no-op update.
 *
 * The destination table shape is SHIPPED (MAILBOX_TABLE_TEMPLATE), not inferred
 * from a sample: a first sample with no attachments would produce a table with
 * no attachment columns, and identity detection could pick the nullable
 * rfc822_message_id over provider_message_id — quietly breaking dedupe forever.
 */

const emailFetch = require('../services/email/fetch');
const { resolveMailboxIdentity, sharedModeFor } = require('./mailboxIdentity');
// The shipped table shapes live in a leaf module so the editor catalog
// (componentSpecs.js) can serve them without loading this connector.
const {
    MAILBOX_TABLE_TEMPLATE,
    MAILBOX_THREAD_TABLE_TEMPLATE,
    MAILBOX_ATTACHMENT_TABLE_TEMPLATE,
    MAILBOX_TABLE_TEMPLATES,
} = require('./mailboxTableTemplates');

const MAX_MAILBOX_ROWS = 200;
// How many conversations one threaded run will expand in full. Each costs a
// provider round-trip, so this is the brake on a busy label.
const MAX_THREAD_EXPANSIONS = 25;

function mailboxError(status, message, code) {
    const err = new Error(message);
    err.status = status;
    if (code) err.code = code;
    return err;
}

// ── Error classification ────────────────────────────────────────────────────

/**
 * Turn a provider failure into something the client can act on.
 *
 * A 403 on a shared mailbox is the single most likely real-world failure (the
 * tenant never granted Mail.*.Shared), and it is NOT a "connect your account"
 * problem — the account is connected, it just cannot reach that mailbox. Saying
 * "connect Outlook" there sends the user in a loop.
 */
function classifyMailboxError(err, connector) {
    if (Number.isInteger(err?.status) && err.code) return err;

    const status = err?.status;
    const isShared = connector?.mode === 'shared';

    if (status === 403) {
        if (isShared) {
            return mailboxError(403,
                `No access to the shared mailbox ${connector.address}. Your Microsoft administrator must grant you Full Access, and the connection needs the Mail.Read.Shared permission — reconnect Microsoft in Settings → Integrations.`,
                'shared_mailbox_denied');
        }
        return mailboxError(403, 'This mailbox refused the request.', 'mailbox_denied');
    }
    if (status === 404 && isShared) {
        return mailboxError(404, `Mailbox ${connector.address} was not found.`, 'mailbox_not_found');
    }
    if (status === 429) {
        const e = mailboxError(429, 'The mail provider is rate limiting us. The next sync will retry.', 'mailbox_throttled');
        if (err.retryAfterMs) e.retryAfterMs = err.retryAfterMs;
        return e;
    }
    if (status === 401 || /invalid_grant|reconnect the mailbox|no valid .* tokens/i.test(String(err?.message || ''))) {
        const e = mailboxError(409, 'The mailbox connection expired — reconnect it in Settings → Integrations.', 'connection_required');
        e.provider = connector?.provider === 'gmail' ? 'gmail' : 'outlook';
        return e;
    }
    return mailboxError(502, `Mailbox sync failed: ${String(err?.message || err).slice(0, 200)}`, 'connector_failed');
}

// ── Runner ──────────────────────────────────────────────────────────────────

/**
 * Run one mailbox pull.
 *
 * @param {object} connector  the `mailbox` connector config
 * @param {object} ctx        { app, viewerId, systemArgs, deps }
 * @returns {Promise<{rows: object[], grains: Array<{level, rows}>}>}
 */
async function runMailboxConnector(connector, ctx = {}) {
    const { app, viewerId = null, systemArgs = {}, deps } = ctx;

    let identity;
    try {
        identity = await resolveMailboxIdentity(connector, { app, viewerId, deps: deps?.mailboxIdentity });
    } catch (err) {
        throw err.code ? err : classifyMailboxError(err, connector);
    }

    // A shared Gmail mailbox is a delivered alias inside the user's own mailbox,
    // never a delegated one — fetch.js encodes that, but be explicit here too so
    // a future reader doesn't "fix" it.
    if (connector.mode === 'shared' && sharedModeFor(connector.provider) === 'delivered_alias' && !connector.address) {
        throw mailboxError(400, 'A shared Gmail mailbox needs the team address to look for.', 'bad_connector');
    }

    const max = Math.min(
        Number.isFinite(connector.maxPerRun) && connector.maxPerRun > 0 ? connector.maxPerRun : 100,
        MAX_MAILBOX_ROWS,
    );

    const lookbackDays = Number.isFinite(connector.lookbackDays) && connector.lookbackDays > 0 ? connector.lookbackDays : 7;
    const lookbackIso = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

    // `since` is the sync watermark. On a first run there is none, so fall back
    // to lookbackDays rather than pulling the entire mailbox history.
    //
    // In THREAD mode the watermark is deliberately not used for the search. A
    // label belongs to a MESSAGE: the reply that lands later carries none, so it
    // matches neither the query nor a watermark that has already moved past the
    // labelled message. The search therefore re-runs over the whole lookback
    // window each time and the threads it finds are expanded in full below —
    // bounded by maxPerRun, and the upsert makes re-seeing a message free.
    let since = connector.groupIntoThreads ? lookbackIso : (systemArgs.since || null);
    if (!since) since = lookbackIso;

    let listed;
    try {
        listed = await emailFetch.listMessages({
            provider: identity.provider,
            tokens: identity.tokens,
            onRefresh: identity.onRefresh,
            mailbox: identity.mailbox,
            folder: connector.folder || 'inbox',
            query: connector.query || '',
            since,
            max,
            includeBody: connector.includeBody !== false,
        });
    } catch (err) {
        throw classifyMailboxError(err, connector);
    }

    let messages = (listed.messages || []).slice(0, max);

    // Thread mode: pull in the rest of each conversation the search touched, so
    // an unlabelled reply still lands on its ticket. Deduped by message id, and
    // capped so one enormous thread cannot swallow a run.
    // Threads we KNOW we are holding only a slice of. Their roll-up columns
    // (message_count, has_unread, first_response_secs) must not be written: a
    // count computed over a slice overwrites a correct 11 with a wrong 3, on
    // every run, for as long as the thread stays busy.
    //
    // Tracked as "known partial" rather than "known complete" on purpose. A
    // mailbox whose provider exposes no thread id has nothing to expand, and
    // then the search result IS everything we can know — calling that partial
    // would mean the count was never written at all.
    const partialThreads = new Set();
    if (connector.groupIntoThreads) {
        const seen = new Set(messages.map((m) => m.provider_message_id));
        const allThreadIds = [...new Set(messages.map((m) => m.provider_thread_id).filter(Boolean))];
        const threadIds = allThreadIds.slice(0, MAX_THREAD_EXPANSIONS);

        // Over the expansion cap: everything past it stays as the search left it.
        const threadKeyByProviderId = new Map();
        for (const m of messages) {
            if (m.provider_thread_id && m.thread_key && !threadKeyByProviderId.has(m.provider_thread_id)) {
                threadKeyByProviderId.set(m.provider_thread_id, m.thread_key);
            }
        }
        for (const id of allThreadIds.slice(MAX_THREAD_EXPANSIONS)) {
            const key = threadKeyByProviderId.get(id);
            if (key) partialThreads.add(key);
        }

        for (const threadId of threadIds) {
            try {
                const full = await emailFetch.listThreadMessages({
                    provider: identity.provider,
                    tokens: identity.tokens,
                    onRefresh: identity.onRefresh,
                    mailbox: identity.mailbox,
                    threadId,
                    includeBody: connector.includeBody !== false,
                });
                for (const m of full) {
                    if (!m.provider_message_id || seen.has(m.provider_message_id)) continue;
                    seen.add(m.provider_message_id);
                    messages.push(m);
                }
            } catch {
                // One unreadable thread must not lose the batch — the messages
                // the search already returned are still worth writing. But we no
                // longer hold it in full, so its counts stay untouched.
                const key = threadKeyByProviderId.get(threadId);
                if (key) partialThreads.add(key);
            }
        }
        // Truncating the batch drops messages we DID fetch, so anything past the
        // cut is a slice too.
        if (messages.length > MAX_MAILBOX_ROWS) {
            for (const m of messages.slice(MAX_MAILBOX_ROWS)) if (m.thread_key) partialThreads.add(m.thread_key);
            messages = messages.slice(0, MAX_MAILBOX_ROWS);
        }
    }

    // Attachment METADATA plus a PENDING descriptor — still no bytes here. The
    // sync stays cheap and stores nothing a stranger sent; the descriptor is
    // redeemed for real bytes the first time someone opens or parses the file
    // (mailboxAttachments.materializeAttachment). `_parentIndex` relates a child
    // row back to the message the sync engine just wrote.
    const attachmentRows = [];
    if (connector.includeAttachmentMeta !== false) {
        for (let i = 0; i < messages.length; i++) {
            if (!messages[i].has_attachments) continue;
            try {
                const metas = await emailFetch.listAttachmentMeta({
                    provider: identity.provider,
                    tokens: identity.tokens,
                    onRefresh: identity.onRefresh,
                    mailbox: identity.mailbox,
                    messageId: messages[i].provider_message_id,
                });
                for (const meta of metas) {
                    attachmentRows.push({
                        ...meta,
                        // The upsert key — SYNTHESISED, because Gmail's
                        // attachment ids are ephemeral tokens that rotate on
                        // every fetch. Keying rows on them meant the upsert
                        // NEVER matched: every 2-minute sync inserted the same
                        // eight attachments again, each older generation holding
                        // an already-expired token. This key is stable across
                        // runs; the live token rides inside the descriptor
                        // below, refreshed on every sync so redemption always
                        // has a usable one.
                        provider_attachment_id: `${messages[i].provider_message_id}:${meta.filename || ''}:${meta.size ?? ''}`,
                        provider_message_id: messages[i].provider_message_id,
                        // Denormalised on purpose: an app filters attachments by
                        // the conversation it is showing, and walking the
                        // relation from a binding filter is not expressible.
                        // Without it the filter matched nothing and the desk
                        // reported "no attachments" on a ticket that had them.
                        thread_key: messages[i].thread_key,
                        // An OBJECT, not JSON text. Serialising a file column is
                        // the query compiler's job (coerceValue): pre-stringifying
                        // here got stringified AGAIN on write, so the stored
                        // value was a JSON string containing a JSON string. One
                        // parse yielded a string, `.kind` was undefined, and the
                        // whole attachment chain — preview, materialize, AI read
                        // — quietly found "no descriptor" on a row that had one.
                        file: {
                            kind: 'mailbox_attachment',
                            connectorId: connector.id,
                            messageId: messages[i].provider_message_id,
                            attachmentId: meta.provider_attachment_id,
                            name: meta.filename,
                            mime: meta.mime_type,
                            size: meta.size,
                            isInline: meta.is_inline,
                        },
                        _parentIndex: i,
                    });
                }
            } catch {
                // One unreadable attachment list must not lose the whole batch —
                // the message row is the valuable part.
            }
        }
    }

    // ── Drop the same file seen twice in one conversation ────────────────
    // A provider's attachment id is per (message, MIME part), so a customer who
    // replies with their invoice still quoted underneath produces a NEW id for
    // the same bytes — and the desk showed "factuur.pdf" three times, each of
    // which downloads separately on first open. Identity here is what a person
    // would use: same name, same size, same type, same conversation. Deliberately
    // not a hash: hashing would mean downloading every attachment at sync time,
    // which is the one thing this design exists to avoid.
    const deduped = [];
    const seenFiles = new Set();
    for (const row of attachmentRows) {
        const scope = row.thread_key || row.provider_message_id || '';
        const key = `${scope}|${row.filename || ''}|${row.size ?? ''}|${row.mime_type || ''}`;
        if (seenFiles.has(key)) continue;
        seenFiles.add(key);
        deduped.push(row);
    }
    attachmentRows.length = 0;
    attachmentRows.push(...deduped);

    // ── Optional: roll the messages up into conversations ────────────────
    // With this on, grain 0 becomes one row per CONVERSATION and grain 1 the
    // messages, each pointing at its conversation through `_parentIndex`. That
    // is what lets an app's main table be "tickets" and have them appear by
    // themselves — without it a mailbox only ever fills a flat message log and
    // something else has to invent the ticket.
    if (connector.groupIntoThreads) {
        const threads = groupIntoThreads(messages, partialThreads);
        // Attachments move down a level with their message. This used to compute
        // attachmentRows and then silently drop them here, so a threaded mailbox
        // — the support desk — never got attachments at all, whatever
        // includeAttachmentMeta said. `_parentIndex` is remapped from the
        // original message order to the position in the regrouped messages
        // grain, because that is now the parent.
        const messageIndexBySource = new Map(threads.messages.map((m, i) => [m.provider_message_id, i]));
        const rebased = [];
        for (const row of attachmentRows) {
            const parent = messageIndexBySource.get(messages[row._parentIndex]?.provider_message_id);
            if (parent === undefined) continue;
            rebased.push({ ...row, _parentIndex: parent });
        }
        return {
            rows: threads.threads,
            grains: [
                { level: 0, rows: threads.threads },
                { level: 1, rows: threads.messages },
                { level: 2, rows: rebased },
            ],
            meta: {
                fetched: messages.length,
                threads: threads.threads.length,
                attachments: rebased.length,
                mailbox: identity.mailbox.address,
            },
        };
    }

    return {
        rows: messages,
        grains: [
            { level: 0, rows: messages },
            { level: 1, rows: attachmentRows },
        ],
        // Surfaced in the sync state so an operator can see throughput.
        meta: { fetched: messages.length, attachments: attachmentRows.length, mailbox: identity.mailbox.address },
    };
}

/**
 * Roll a flat message list into conversations.
 *
 * Order matters twice over:
 *  • threads keep FIRST-SEEN order, and each message's `_parentIndex` is the
 *    index into that array — connectorSync relates a child row to its parent
 *    positionally, never by matching a column.
 *  • the conversation's summary fields come from the NEWEST message in the
 *    batch, so a re-sync moves `last_message_at` forward rather than back.
 *
 * The emitted columns are deliberately only the ones the mailbox owns. An
 * upsert UPDATE writes exactly the columns present in the row, so anything the
 * team owns — status, priority, assignee — survives every re-sync untouched.
 */
function groupIntoThreads(messages, partialThreads = null) {
    const byKey = new Map();
    const outMessages = [];

    for (const msg of messages) {
        const key = msg.thread_key || msg.provider_thread_id || msg.provider_message_id;
        if (!key) continue;

        let entry = byKey.get(key);
        if (!entry) {
            entry = {
                index: byKey.size,
                complete: !partialThreads || !partialThreads.has(key),
                firstInboundAt: null,
                firstOutboundAfterAt: null,
                thread: {
                    thread_key: key,
                    subject: msg.subject || '(no subject)',
                    requester_email: '',
                    requester_name: '',
                    last_message_at: null,
                    message_count: 0,
                    has_unread: false,
                    mailbox_address: msg.mailbox_address || '',
                    provider: msg.provider || '',
                },
            };
            byKey.set(key, entry);
        }

        const t = entry.thread;
        t.message_count += 1;
        // Unread is a property of the conversation: one unread inbound message
        // is enough to make the whole thread need attention.
        if (msg.direction === 'inbound' && msg.is_read === false) t.has_unread = true;

        // First response time — a fact about the MAIL, not a judgement, which is
        // why it belongs here and not in a routine. Computed only for threads we
        // hold in full (see `complete` below).
        const at = msg.received_at || null;
        if (at && msg.direction === 'inbound' && (!entry.firstInboundAt || at < entry.firstInboundAt)) {
            entry.firstInboundAt = at;
        }
        if (at && msg.direction === 'outbound') {
            if (!entry.firstOutboundAfterAt || at < entry.firstOutboundAfterAt) entry.firstOutboundAfterAt = at;
        }

        // The customer is whoever wrote IN — never our own outbound address.
        if (msg.direction === 'inbound' && msg.from_email && !t.requester_email) {
            t.requester_email = msg.from_email;
            t.requester_name = msg.from_name || '';
        }

        if (at && (!t.last_message_at || at > t.last_message_at)) {
            t.last_message_at = at;
            // Subject follows the newest message so a renamed thread reads right.
            if (msg.subject) t.subject = msg.subject;
        }

        // Fallback recipient: a thread whose only messages are OUTBOUND has no
        // customer by the rule above, so its Reply button had nobody to send to
        // and failed at submit. Remember who it was addressed to; used only if
        // no inbound message ever turns up.
        if (!t.requester_email && msg.direction === 'outbound' && msg.to_emails) {
            entry.fallbackTo = entry.fallbackTo || String(msg.to_emails).split(',')[0].trim();
        }

        outMessages.push({ ...msg, _parentIndex: entry.index });
    }

    return {
        threads: [...byKey.values()].map((e) => {
            if (!e.thread.requester_email && e.fallbackTo) e.thread.requester_email = e.fallbackTo;

            if (e.complete) {
                // Only a thread held in full can be measured. A first-response
                // time computed over a slice is not "approximate", it is a
                // different number every run.
                const { firstInboundAt, firstOutboundAfterAt } = e;
                if (firstInboundAt && firstOutboundAfterAt && firstOutboundAfterAt > firstInboundAt) {
                    e.thread.first_response_secs = Math.round(
                        (Date.parse(firstOutboundAfterAt) - Date.parse(firstInboundAt)) / 1000,
                    );
                }
                return e.thread;
            }

            // A PARTIAL thread — the run hit MAX_THREAD_EXPANSIONS, so we are
            // looking at whatever the search happened to match. Drop the roll-up
            // columns rather than overwrite a correct stored value with a
            // smaller wrong one: an upsert only writes the columns present, so
            // omitting them leaves the previous, complete answer alone.
            const { message_count: _c, has_unread: _u, ...partial } = e.thread;
            return partial;
        }),
        messages: outMessages,
    };
}

module.exports = {
    runMailboxConnector,
    computeThreadKey: emailFetch.computeThreadKey,
    classifyMailboxError,
    MAILBOX_TABLE_TEMPLATE,
    MAILBOX_THREAD_TABLE_TEMPLATE,
    MAILBOX_ATTACHMENT_TABLE_TEMPLATE,
    MAILBOX_TABLE_TEMPLATES,
    _groupIntoThreads: groupIntoThreads,
    MAX_MAILBOX_ROWS,
};
