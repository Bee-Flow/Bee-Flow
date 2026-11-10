// @typecheck
'use strict';

/**
 * Regression: the Nextcloud file.new trigger must fire when a file APPEARS in
 * the watched folder — including files MOVED / COPIED / RENAMED in, not just
 * fresh uploads. Nextcloud reports a move as `file_changed` (+ "moved … to"
 * subject), so the file.new detector reads the subject for arrivals while
 * leaving plain in-place edits to file.changed only.
 * (Moved here from ../../triggerBus.ncfilenew.test.js when triggerBus.js was split.)
 *
 * Run: node --test automation/triggerBus/pollers/nextcloud.test.js
 */

const { test } = require('node:test');
const assert = require('assert');
const { _ncNormaliseActivity } = require('./nextcloud');

const norm = (row) => _ncNormaliseActivity(row, {});

test('fresh upload (file_created) → file.new', () => {
    const p = norm({ id: 1, type: 'file_created', subject: 'You created Invoice.pdf', object_name: '/Invoices/test/Invoice.pdf', objectName: '/Invoices/test/Invoice.pdf' });
    assert.strictEqual(p._isFileCreated, true);
});

test('file MOVED into the folder (file_changed, "moved … to") → file.new', () => {
    const p = norm({ id: 2, type: 'file_changed', subject: 'You moved Invoices/Factuur_255066638.pdf to Invoices/test', objectName: '/Invoices/test/Factuur_255066638.pdf' });
    assert.strictEqual(p._isFileCreated, true, 'a moved-in file is a new arrival → file.new');
});

test('Dutch move subject ("verplaatst") → file.new', () => {
    const p = norm({ id: 3, type: 'file_changed', subject: 'Je hebt Factuur.pdf verplaatst naar Invoices/test', objectName: '/Invoices/test/Factuur.pdf' });
    assert.strictEqual(p._isFileCreated, true);
});

test('copied / restored / renamed → file.new', () => {
    assert.strictEqual(norm({ id: 4, type: 'file_changed', subject: 'You copied X.pdf', objectName: '/Invoices/test/X.pdf' })._isFileCreated, true);
    assert.strictEqual(norm({ id: 5, type: 'file_restored', subject: 'You restored X.pdf', objectName: '/Invoices/test/X.pdf' })._isFileCreated, true);
    assert.strictEqual(norm({ id: 6, type: 'file_changed', subject: 'You renamed A.pdf to B.pdf', objectName: '/Invoices/test/B.pdf' })._isFileCreated, true);
});

test('plain in-place EDIT (file_changed, "changed") is NOT file.new', () => {
    const p = norm({ id: 7, type: 'file_changed', subject: 'You changed Invoice.pdf', objectName: '/Invoices/test/Invoice.pdf' });
    assert.strictEqual(p._isFileCreated, false, 'an edit must stay file.changed only');
    assert.strictEqual(p._isFileChanged, true);
});

// ── Recognised on the rich subject's parameter names, in any language ────
// (subjects as Nextcloud words them for a German, French and Dutch user)

test('German: a file moved into the folder → file.new; an edit stays file.changed only', () => {
    const moved = norm({ id: 20, type: 'file_changed', subject: 'Du hast Rechnung.pdf nach Rechnungen/Rechnung.pdf verschoben', richKeys: ['newfile', 'oldfile'], objectName: '/Rechnungen/Rechnung.pdf' });
    assert.strictEqual(moved._isFileCreated, true);
    assert.strictEqual(moved._isFileChanged, true);
    const byOther = norm({ id: 21, type: 'file_changed', subject: 'bob hat Rechnung.pdf nach Rechnungen/Rechnung.pdf verschoben', richKeys: ['newfile', 'user', 'oldfile'], objectName: '/Rechnungen/Rechnung.pdf' });
    assert.strictEqual(byOther._isFileCreated, true);
    const edit = norm({ id: 22, type: 'file_changed', subject: 'Du hast Rechnung.pdf geändert', richKeys: ['file'], objectName: '/Rechnungen/Rechnung.pdf' });
    assert.strictEqual(edit._isFileCreated, false);
    assert.strictEqual(edit._isFileChanged, true);
});

test('French: a move and a rename → file.new; an edit stays file.changed only', () => {
    assert.strictEqual(norm({ id: 23, type: 'file_changed', subject: 'Vous avez déplacé Facture.pdf dans Factures/Facture.pdf', richKeys: ['newfile', 'oldfile'], objectName: '/Factures/Facture.pdf' })._isFileCreated, true);
    assert.strictEqual(norm({ id: 24, type: 'file_changed', subject: 'alice a renommé A.pdf en B.pdf', richKeys: ['newfile', 'user', 'oldfile'], objectName: '/Factures/B.pdf' })._isFileCreated, true);
    assert.strictEqual(norm({ id: 25, type: 'file_changed', subject: 'Vous avez modifié Facture.pdf', richKeys: ['file'], objectName: '/Factures/Facture.pdf' })._isFileCreated, false);
});

test('Dutch: a move in the wording Nextcloud uses → file.new; several files in one row (numbered names) too', () => {
    assert.strictEqual(norm({ id: 26, type: 'file_changed', subject: 'Je verplaatste Factuur.pdf naar Facturen/Factuur.pdf', richKeys: ['newfile', 'oldfile'], objectName: '/Facturen/Factuur.pdf' })._isFileCreated, true);
    assert.strictEqual(norm({ id: 27, type: 'file_changed', subject: 'Je hernoemde A.pdf naar B.pdf', richKeys: ['newfile1', 'oldfile1', 'newfile2', 'oldfile2'], objectName: '/Facturen/B.pdf' })._isFileCreated, true);
    assert.strictEqual(norm({ id: 28, type: 'file_changed', subject: 'Je wijzigde Factuur.pdf', richKeys: ['file'], objectName: '/Facturen/Factuur.pdf' })._isFileCreated, false);
});

test('a share: the English subject still decides; a share the user made is not a received one', () => {
    const me = { nextcloudUid: 'alice' };
    const received = _ncNormaliseActivity({ id: 30, type: 'shared', actor: 'bob', subject: 'bob shared Plan.docx with you', richKeys: ['file', 'actor'], objectId: 55 }, me);
    assert.strictEqual(received._isShareReceived, true);
    const withdrawn = _ncNormaliseActivity({ id: 31, type: 'shared', actor: 'bob', subject: 'bob removed you from the share named Plan.docx', richKeys: ['file', 'actor'], objectId: 55 }, me);
    assert.strictEqual(withdrawn._isShareReceived, false);
    const made = _ncNormaliseActivity({ id: 32, type: 'shared', actor: 'alice', subject: 'You shared Plan.docx with bob', richKeys: ['file', 'user'], objectId: 55 }, me);
    assert.strictEqual(made._isShareReceived, false);
    const reshared = _ncNormaliseActivity({ id: 33, type: 'shared', actor: 'bob', subject: 'bob shared Plan.docx with carol', richKeys: ['file', 'user', 'actor'], objectId: 55 }, me);
    assert.strictEqual(reshared._isShareReceived, false);
    // A row without rich parameters keeps the subject match.
    assert.strictEqual(norm({ id: 34, type: 'shared', subject: 'bob shared Plan.docx with you' })._isShareReceived, true);
});

test('path + name + extension are normalised from objectName', () => {
    const p = norm({ id: 8, type: 'file_created', subject: 'created', objectName: '/Invoices/test/Factuur.pdf' });
    assert.strictEqual(p.path, '/Invoices/test/Factuur.pdf');
    assert.strictEqual(p.name, 'Factuur.pdf');
    assert.strictEqual(p.extension, 'pdf');
});


// ── Pollers, driven through a fake ctx (no Nextcloud, no DB) ────────────

const { createNextcloudPollers, _ncActivityCacheReset } = require('./nextcloud');

function ncCtx({ activities = [], notifications = [], events = [] } = {}) {
    const updates = [];
    const ctx = {
        store: () => ({ updateSubscription: async (id, u) => { updates.push({ id, ...u }); } }),
        ncScopeGuard: () => ({ guardedNcCall: async (_name, _args, _c, run) => run() }),
        nextcloudActivityTools: () => ({ executeNextcloudActivityTool: async () => ({ activities: activities.slice() }) }),
        nextcloudNotificationsTools: () => ({ executeNextcloudNotificationsTool: async () => ({ notifications }) }),
        nextcloudCalendarTools: () => ({ executeNextcloudCalendarTool: async () => ({ events }) }),
    };
    return { ctx, updates };
}

test('activity channel: first poll only anchors the cursor at the newest activity id', async () => {
    const { ctx, updates } = ncCtx({ activities: [{ id: 5, type: 'file_created', objectName: '/a.pdf' }, { id: 9, type: 'file_created', objectName: '/b.pdf' }] });
    const out = await createNextcloudPollers(ctx)['file.new']({ id: 'sub-1', userId: 'nc-user-anchor', lastCursor: null }, {});
    assert.deepStrictEqual(out, []);
    assert.deepStrictEqual(updates, [{ id: 'sub-1', lastCursor: '9' }]);
});

test('activity channel: emits only fresh rows the predicate accepts and advances the cursor', async () => {
    const { ctx, updates } = ncCtx({
        activities: [
            { id: 3, type: 'file_created', subject: 'created', objectName: '/old.pdf' },
            { id: 4, type: 'file_changed', subject: 'You changed x.pdf', objectName: '/x.pdf' },
            { id: 6, type: 'file_created', subject: 'created', objectName: '/new.pdf' },
        ],
    });
    const out = await createNextcloudPollers(ctx)['file.new']({ id: 'sub-2', userId: 'nc-user-fresh', lastCursor: '3' }, {});
    assert.deepStrictEqual(out.map(e => e.activityId), [6], 'an in-place edit is not file.new; the old row is behind the cursor');
    assert.deepStrictEqual(updates, [{ id: 'sub-2', lastCursor: '6' }]);
});

test('activity channel: an error answer from the activity read is logged, once per interval per user', async (t) => {
    const log = require('../../../telemetry/log');
    const warn = t.mock.method(log, 'warn', () => {});
    const saved = process.env.AUTOMATION_NC_ACTIVITY_WARN_INTERVAL_SECONDS;
    t.after(() => {
        if (saved === undefined) delete process.env.AUTOMATION_NC_ACTIVITY_WARN_INTERVAL_SECONDS;
        else process.env.AUTOMATION_NC_ACTIVITY_WARN_INTERVAL_SECONDS = saved;
    });
    delete process.env.AUTOMATION_NC_ACTIVITY_WARN_INTERVAL_SECONDS;
    const { ctx, updates } = ncCtx();
    /** @type {any} */ (ctx).nextcloudActivityTools = () => ({ executeNextcloudActivityTool: async () => ({ error: 'Nextcloud Activity is not available (404)' }) });
    const { _ncFetchActivityRows } = require('./nextcloud');

    const out = await createNextcloudPollers(ctx)['share.received']({ id: 'sub-e', userId: 'nc-user-error', lastCursor: '3' }, {});
    assert.deepStrictEqual(out, []);
    assert.deepStrictEqual(updates, [], 'nothing was read, so the cursor stays');
    assert.strictEqual(warn.mock.callCount(), 1);
    assert.match(String(warn.mock.calls[0].arguments[0]), /activity fetch failed for user nc-user-error: Nextcloud Activity is not available \(404\)/);

    // The same user again inside the interval: no second line. Another user: its own line.
    _ncActivityCacheReset('nc-user-error');
    await _ncFetchActivityRows(ctx, 'nc-user-error', {});
    assert.strictEqual(warn.mock.callCount(), 1);
    await _ncFetchActivityRows(ctx, 'nc-user-error-2', {});
    assert.strictEqual(warn.mock.callCount(), 2);

    // 0 = every failed read is logged.
    process.env.AUTOMATION_NC_ACTIVITY_WARN_INTERVAL_SECONDS = '0';
    _ncActivityCacheReset('nc-user-error');
    await _ncFetchActivityRows(ctx, 'nc-user-error', {});
    assert.strictEqual(warn.mock.callCount(), 3);
});

// ── share.received in any language: asked from the incoming shares ──────

const ROW_TIME = '2026-11-10T10:00:00+00:00';
const secondsOf = (iso) => Math.floor(Date.parse(iso) / 1000);

/**
 * A share.received ctx. `shared` = what is shared with the user now (null = the
 * read fails): a file id (a share made when the rows were written) or
 * `[file id, when the share was made]`. `guard` replaces the access guard.
 */
function shareCtx(activities, shared, guard = null) {
    const made = ncCtx({ activities });
    let reads = 0;
    const guarded = [];
    made.ctx.nextcloudActivityTools = () => ({
        executeNextcloudActivityTool: async () => ({ activities: activities.slice() }),
        incomingShares: async () => {
            reads += 1;
            if (!shared) return null;
            const shares = shared.map((s) => (Array.isArray(s) ? s : [s, ROW_TIME]))
                .map(([id, at]) => ({ path: `/in/${id}`, fileIds: [String(id)], sharedAt: secondsOf(at) }));
            return { count: shares.length, shares };
        },
    });
    made.ctx.ncScopeGuard = () => ({
        guardedNcCall: async (name, args, who, run) => {
            guarded.push({ name, args, userId: who.userId });
            return guard ? guard(name, run) : run();
        },
    });
    return { ...made, reads: () => reads, guarded };
}

const ME = { nextcloudUid: 'alice' };
const shareRow = (id, subject, extra = {}) => ({ id, type: 'shared', actor: 'bob', subject, richKeys: ['file', 'actor'], objectId: 55, objectName: '/Plan.docx', datetime: ROW_TIME, ...extra });

test('share.received: a Dutch, German and French received share fires', async () => {
    const { ctx, reads } = shareCtx([
        shareRow(11, 'bob heeft Plan.docx met je gedeeld', { objectId: 55 }),
        shareRow(12, 'bob hat Plan.docx mit dir geteilt', { objectId: 56 }),
        shareRow(13, 'bob a partagé Plan.docx avec vous', { objectId: 57 }),
    ], ['55', '56', '57']);
    const out = await createNextcloudPollers(ctx)['share.received']({ id: 's-nl', userId: 'nc-share-langs', lastCursor: '10' }, ME);
    assert.deepStrictEqual(out.map(e => e.activityId), [11, 12, 13]);
    assert.strictEqual(reads(), 1, 'one read of the incoming shares per tick');
});

test('share.received: a withdrawn share, a share the user made and an own action do not fire', async () => {
    const { ctx } = shareCtx([
        shareRow(11, 'bob verwijderde je van share Plan.docx', { objectId: 55 }),
        shareRow(12, 'Du hast Plan.docx mit bob geteilt', { actor: 'alice', richKeys: ['file', 'user'], objectId: 56 }),
        shareRow(13, 'Je verwijderde jezelf van Plan.docx', { actor: 'alice', objectId: 57 }),
        shareRow(14, 'bob a partagé Plan.docx avec carol', { richKeys: ['file', 'user', 'actor'], objectId: 58 }),
    ], ['56', '57', '58']);
    const out = await createNextcloudPollers(ctx)['share.received']({ id: 's-no', userId: 'nc-share-none', lastCursor: '10' }, ME);
    assert.deepStrictEqual(out, []);
});

test('share.received: per file only the newest row counts', async () => {
    // Withdrawn, then shared again: one event, for the newest row.
    const again = shareCtx([
        shareRow(11, 'bob hat dich aus der Freigabe von Plan.docx entfernt'),
        shareRow(12, 'bob hat Plan.docx mit dir geteilt'),
    ], ['55']);
    const out = await createNextcloudPollers(again.ctx)['share.received']({ id: 's-a', userId: 'nc-share-again', lastCursor: '10' }, ME);
    assert.deepStrictEqual(out.map(e => e.activityId), [12]);
    // English: shared, then withdrawn while another share keeps the file visible. The subject decided the first row; the second is not asked.
    const en = shareCtx([
        shareRow(11, 'bob removed you from the share named Plan.docx'),
        shareRow(12, 'bob shared Plan.docx with you'),
    ], ['55']);
    const enOut = await createNextcloudPollers(en.ctx)['share.received']({ id: 's-en', userId: 'nc-share-en', lastCursor: '10' }, ME);
    assert.deepStrictEqual(enOut.map(e => e.activityId), [12]);
    assert.strictEqual(en.reads(), 0, 'English subjects need no read');
});

test('share.received: a withdrawn share does not fire while an older share keeps the file with the user', async () => {
    // The file is still shared (through a group, or by someone else) since the day before.
    const older = [['55', '2026-11-09T08:00:00+00:00']];
    for (const subject of [
        'bob removed you from the share named Plan.docx',
        'bob verwijderde je van share Plan.docx',
        'bob hat dich aus der Freigabe von Plan.docx entfernt',
    ]) {
        const { ctx, reads } = shareCtx([shareRow(11, subject)], older);
        const out = await createNextcloudPollers(ctx)['share.received']({ id: 's-w', userId: `nc-share-withdrawn-${subject.length}`, lastCursor: '10' }, ME);
        assert.deepStrictEqual(out, [], subject);
        assert.strictEqual(reads(), 1);
    }
});

test('share.received: the share is as old as the row, within AUTOMATION_NC_SHARE_CONFIRM_MARGIN_SECONDS (default 10, 0 = not older)', async (t) => {
    const prev = process.env.AUTOMATION_NC_SHARE_CONFIRM_MARGIN_SECONDS;
    t.after(() => { if (prev === undefined) delete process.env.AUTOMATION_NC_SHARE_CONFIRM_MARGIN_SECONDS; else process.env.AUTOMATION_NC_SHARE_CONFIRM_MARGIN_SECONDS = prev; });
    delete process.env.AUTOMATION_NC_SHARE_CONFIRM_MARGIN_SECONDS;
    const poll = async (userId, madeAt, row = {}) => {
        const { ctx } = shareCtx([shareRow(11, 'bob heeft Plan.docx met je gedeeld', row)], [['55', madeAt]]);
        return (await createNextcloudPollers(ctx)['share.received']({ id: 's-m', userId, lastCursor: '10' }, ME)).length;
    };
    assert.strictEqual(await poll('nc-share-m1', '2026-11-10T09:59:52+00:00'), 1, '8 seconds before the row');
    assert.strictEqual(await poll('nc-share-m2', '2026-11-10T09:59:40+00:00'), 0, '20 seconds before the row');
    assert.strictEqual(await poll('nc-share-m3', '2026-11-10T10:00:03+00:00'), 1, 'after the row');
    assert.strictEqual(await poll('nc-share-m4', ROW_TIME, { datetime: undefined }), 0, 'a row without a time is not confirmed');
    process.env.AUTOMATION_NC_SHARE_CONFIRM_MARGIN_SECONDS = '0';
    assert.strictEqual(await poll('nc-share-m5', '2026-11-10T09:59:59+00:00'), 0);
    assert.strictEqual(await poll('nc-share-m6', ROW_TIME), 1);
    process.env.AUTOMATION_NC_SHARE_CONFIRM_MARGIN_SECONDS = '60';
    assert.strictEqual(await poll('nc-share-m7', '2026-11-10T09:59:40+00:00'), 1);
});

test('share.received: the incoming shares are read as the Files share listing, under the access settings', async (t) => {
    const log = require('../../../telemetry/log');
    const warn = t.mock.method(log, 'warn', () => {});
    const rows = [
        shareRow(11, 'bob heeft Plan.docx met je gedeeld', { objectId: 55 }),
        shareRow(12, 'bob heeft Notes.md met je gedeeld', { objectId: 56 }),
    ];
    const sub = (userId) => ({ id: 's-g', userId, lastCursor: '10' });

    // Allowed: one guarded call, by the name of the share-listing tool.
    const open = shareCtx(rows, ['55', '56']);
    assert.strictEqual((await createNextcloudPollers(open.ctx)['share.received'](sub('nc-share-g1'), ME)).length, 2);
    assert.deepStrictEqual(open.guarded.filter((g) => g.name !== 'nextcloud_activity_list'),
        [{ name: 'nextcloud_list_shares', args: { shared_with_me: true }, userId: 'nc-share-g1' }]);

    // A selection that leaves one share out: only the other row fires.
    const trimming = async (name, run) => {
        const result = await run();
        return name === 'nextcloud_list_shares' ? { ...result, shares: result.shares.filter((s) => s.path === '/in/56') } : result;
    };
    const narrowed = shareCtx(rows, ['55', '56'], trimming);
    const some = await createNextcloudPollers(narrowed.ctx)['share.received'](sub('nc-share-g2'), ME);
    assert.deepStrictEqual(some.map((e) => e.activityId), [12]);

    // Not allowed at all: nothing is read, nothing fires, nothing is logged, the cursor moves on.
    const denying = async (name, run) => (name === 'nextcloud_list_shares' ? { error: 'limited', nc_scope_denied: true } : run());
    const denied = shareCtx(rows, ['55', '56'], denying);
    assert.deepStrictEqual(await createNextcloudPollers(denied.ctx)['share.received'](sub('nc-share-g3'), ME), []);
    assert.strictEqual(denied.reads(), 0);
    assert.deepStrictEqual(denied.updates, [{ id: 's-g', lastCursor: '12' }]);
    assert.strictEqual(warn.mock.callCount(), 0);
});

test('share.received: the incoming shares cannot be read → those rows stay unrecognised, the cursor moves on', async (t) => {
    const log = require('../../../telemetry/log');
    const warn = t.mock.method(log, 'warn', () => {});
    const { ctx, updates } = shareCtx([shareRow(11, 'bob heeft Plan.docx met je gedeeld')], null);
    const out = await createNextcloudPollers(ctx)['share.received']({ id: 's-f', userId: 'nc-share-fail', lastCursor: '10' }, ME);
    assert.deepStrictEqual(out, []);
    assert.deepStrictEqual(updates, [{ id: 's-f', lastCursor: '11' }]);
    assert.match(String(warn.mock.calls[0].arguments[0]), /incoming share list failed for user nc-share-fail/);
});

test('share.received: the other channels never read the incoming shares', async () => {
    const { ctx, reads } = shareCtx([shareRow(11, 'bob heeft Plan.docx met je gedeeld')], ['55']);
    const out = await createNextcloudPollers(ctx)['activity.new']({ id: 's-o', userId: 'nc-share-other', lastCursor: '10' }, ME);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0]._isShareReceived, false);
    assert.strictEqual(reads(), 0);
});

test('notification.new: anchors on the first non-empty poll, then emits only newer ids', async () => {
    const first = ncCtx({ notifications: [{ id: 2 }, { id: 7 }] });
    assert.deepStrictEqual(await createNextcloudPollers(first.ctx)['notification.new']({ id: 'n1', userId: 'u', lastCursor: null }, {}), []);
    assert.deepStrictEqual(first.updates, [{ id: 'n1', lastCursor: '7' }]);

    const next = ncCtx({ notifications: [{ id: 7, subject: 'old' }, { id: 8, app: 'files', subject: 'new' }] });
    const out = await createNextcloudPollers(next.ctx)['notification.new']({ id: 'n1', userId: 'u', lastCursor: '7' }, {});
    assert.deepStrictEqual(out.map(n => n.notificationId), [8]);
    assert.deepStrictEqual(next.updates, [{ id: 'n1', lastCursor: '8' }]);
});

// ── calendar.event.upcoming: every calendar, a configurable lead cap (#193) ──

const { upcomingLeadMinutes, upcomingCalendars } = require('./nextcloud');

/** A calendar ctx: `byCal` maps a calendar URI to its events; `list` is the calendar list. */
function calCtx({ byCal = {}, list = null, failing = [] } = {}) {
    const asked = [];
    const updates = [];
    const ctx = {
        store: () => ({ updateSubscription: async (id, u) => { updates.push({ id, ...u }); } }),
        ncScopeGuard: () => ({ guardedNcCall: async (_name, _args, _c, run) => run() }),
        nextcloudCalendarTools: () => ({
            executeNextcloudCalendarTool: async (name, args) => {
                if (name === 'nextcloud_calendar_list') return list ? { calendars: list } : { error: 'no list' };
                asked.push(args.calendar);
                if (failing.includes(args.calendar)) return { error: 'Calendar not found' };
                return { events: byCal[args.calendar] || [] };
            },
        }),
    };
    return { ctx, asked, updates };
}

const inMinutes = (m) => new Date(Date.now() + m * 60_000).toISOString();

test('upcoming: with no calendar named, every calendar the user has is read', async () => {
    const { ctx, asked } = calCtx({
        list: [{ slug: 'personal' }, { slug: 'work' }, { slug: 'team_shared_by_bob' }],
        byCal: { work: [{ uid: 'w1', dtstart: inMinutes(10), summary: 'Standup' }], team_shared_by_bob: [{ uid: 't1', dtstart: inMinutes(5) }] },
    });
    const out = await createNextcloudPollers(ctx)['calendar.event.upcoming']({ id: 's', userId: 'u', lastCursor: null, filter: {} }, {});
    assert.deepStrictEqual(asked, ['personal', 'work', 'team_shared_by_bob']);
    assert.deepStrictEqual(out.map(e => [e.uid, e.calendarUri, e.calendarId]), [['w1', 'work', 'work'], ['t1', 'team_shared_by_bob', 'team_shared_by_bob']]);
});

test('upcoming: a named calendar (or a list of them) narrows the read; the list cannot be read → personal', async () => {
    const one = calCtx({ list: [{ slug: 'personal' }, { slug: 'work' }] });
    await createNextcloudPollers(one.ctx)['calendar.event.upcoming']({ id: 's', userId: 'u', lastCursor: null, filter: { calendarId: 'work' } }, {});
    assert.deepStrictEqual(one.asked, ['work']);
    const many = calCtx();
    await createNextcloudPollers(many.ctx)['calendar.event.upcoming']({ id: 's', userId: 'u', lastCursor: null, filter: { calendars: ['a', 'b', 'a'] } }, {});
    assert.deepStrictEqual(many.asked, ['a', 'b']);
    const fallback = calCtx({ list: null });
    await createNextcloudPollers(fallback.ctx)['calendar.event.upcoming']({ id: 's', userId: 'u', lastCursor: null, filter: {} }, {});
    assert.deepStrictEqual(fallback.asked, ['personal']);
});

test('upcoming: one event in two calendars fires once; one failing calendar does not stop the others', async () => {
    const ev = { uid: 'same', dtstart: inMinutes(3) };
    const { ctx, updates } = calCtx({ list: [{ slug: 'a' }, { slug: 'b' }, { slug: 'broken' }], byCal: { a: [ev], b: [ev] }, failing: ['broken'] });
    const out = await createNextcloudPollers(ctx)['calendar.event.upcoming']({ id: 's', userId: 'u', lastCursor: null, filter: {} }, {});
    assert.strictEqual(out.length, 1);
    assert.strictEqual(JSON.parse(updates[0].lastCursor).firedIds.length, 1);
});

test('upcoming: every calendar failing leaves the cursor alone', async () => {
    const { ctx, updates } = calCtx({ list: [{ slug: 'a' }], failing: ['a'] });
    const out = await createNextcloudPollers(ctx)['calendar.event.upcoming']({ id: 's', userId: 'u', lastCursor: null, filter: {} }, {});
    assert.deepStrictEqual(out, []);
    assert.deepStrictEqual(updates, []);
});

test('upcoming: leadMinutes is capped by AUTOMATION_NC_UPCOMING_MAX_LEAD_MINUTES (default a day, 0 = no cap)', () => {
    const saved = process.env.AUTOMATION_NC_UPCOMING_MAX_LEAD_MINUTES;
    try {
        delete process.env.AUTOMATION_NC_UPCOMING_MAX_LEAD_MINUTES;
        assert.strictEqual(upcomingLeadMinutes(undefined), 15);
        assert.strictEqual(upcomingLeadMinutes(600), 600, 'no longer clamped to 240');
        assert.strictEqual(upcomingLeadMinutes(5000), 1440);
        assert.strictEqual(upcomingLeadMinutes(-3), 15);
        process.env.AUTOMATION_NC_UPCOMING_MAX_LEAD_MINUTES = '0';
        assert.strictEqual(upcomingLeadMinutes(5000), 5000);
        process.env.AUTOMATION_NC_UPCOMING_MAX_LEAD_MINUTES = '60';
        assert.strictEqual(upcomingLeadMinutes(90), 60);
    } finally {
        if (saved === undefined) delete process.env.AUTOMATION_NC_UPCOMING_MAX_LEAD_MINUTES;
        else process.env.AUTOMATION_NC_UPCOMING_MAX_LEAD_MINUTES = saved;
    }
});

test('upcomingCalendars: a failing list call falls back to personal', async () => {
    assert.deepStrictEqual(await upcomingCalendars({}, async () => { throw new Error('down'); }), ['personal']);
});
