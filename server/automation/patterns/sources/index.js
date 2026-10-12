// @typecheck
'use strict';
/**
 * The pattern sources: which exist, which the user has, and collecting them.
 *
 * SOURCE_GROUPS is the one registry. Four groups, each `live` (read from the
 * app at scan time) or `stored` (what Bee Flow already keeps):
 *
 *   mail      live    gmail, outlook, nextcloud_mail
 *   calendar  stored  teams, gmeet, meetings (meeting notes from Talk rooms)
 *   files     live    nextcloud, onedrive, google_drive
 *   beeflow   stored  chat (manual tool calls), documents (knowledge uploads)
 *
 * An app counts as connected when the user's available tools include what it
 * needs: every tool a live app calls, any tool of the account a stored
 * meeting import rides on. Bee Flow's own two are always there.
 *
 * collectAll runs the selected, connected apps, at most 3 at a time, each
 * within 20 s and all within 75 s, and stops on the caller's abort signal. A
 * source that fails, is slow or runs out of budget becomes a `skipped` step
 * with a reason code (auth, error, timeout, budget, aborted, not_connected,
 * shield); it never fails the scan.
 *
 * Live calls go through the caller's executeTool(name, args, { signal }),
 * wrapped here so that only the read-only tools this registry names can be
 * called, and only when the user has them: the model never picks a call or an
 * argument. The caller's executor is where the Privacy Shield and the
 * `pattern_scan` audit source belong; the signal aborts when a source is cut.
 *
 * Progress: a source that runs reports `start`, then `done` or `skipped`; one
 * cut before it starts (abort, budget) reports `skipped` only.
 */

const log = require('../../../telemetry/log');
const { isSideEffect } = require('../../sideEffectMap');
const { sourceError, DAY } = require('./common');
const mailLive = require('./mailLive');
const filesLive = require('./filesLive');
const meetings = require('./meetings');
const { collectToolLedger } = require('./toolLedger');
const { collectDocumentUploads } = require('./documents');

const WINDOW_DAYS = 90;
const LIMITS = Object.freeze({ concurrency: 3, perSourceMs: 20_000, totalMs: 75_000 });

/**
 * @typedef {{
 *   id: string, label: string,
 *   tools?: string[],          // live: every tool the collector calls
 *   connectedBy?: string[],    // stored: any available tool with one of these prefixes
 *   always?: boolean,          // stored in Bee Flow itself
 *   collect: (ctx: any) => Promise<any[]>,
 * }} SourceApp
 * @typedef {{ id: 'mail'|'calendar'|'files'|'beeflow', kind: 'live'|'stored', apps: SourceApp[] }} SourceGroup
 */

/** @type {ReadonlyArray<SourceGroup>} */
const SOURCE_GROUPS = Object.freeze([
    {
        id: 'mail', kind: 'live', apps: [
            { id: 'gmail', label: 'Gmail', tools: ['gmail_search'], collect: mailLive.collectGmail },
            { id: 'outlook', label: 'Outlook', tools: ['outlook_list_recent'], collect: mailLive.collectOutlook },
            {
                id: 'nextcloud_mail', label: 'Nextcloud Mail',
                tools: ['nextcloud_mail_list_accounts', 'nextcloud_mail_list_mailboxes', 'nextcloud_mail_search'],
                collect: mailLive.collectNextcloudMail,
            },
        ],
    },
    {
        id: 'calendar', kind: 'stored', apps: [
            { id: 'teams', label: 'Microsoft Teams', connectedBy: ['teams_', 'ms_calendar_', 'outlook_'], collect: meetings.collectTeamsMeetings },
            { id: 'gmeet', label: 'Google Meet', connectedBy: ['calendar_'], collect: meetings.collectGmeetMeetings },
            { id: 'meetings', label: 'Meeting notes', connectedBy: ['nextcloud_talk_'], collect: meetings.collectTalkMeetings },
        ],
    },
    {
        id: 'files', kind: 'live', apps: [
            { id: 'nextcloud', label: 'Nextcloud Files', tools: ['nextcloud_activity_list'], collect: filesLive.collectNextcloudFiles },
            { id: 'onedrive', label: 'OneDrive', tools: ['onedrive_list_recent'], collect: filesLive.collectOneDrive },
            { id: 'google_drive', label: 'Google Drive', tools: ['drive_list_recent'], collect: filesLive.collectGoogleDrive },
        ],
    },
    {
        id: 'beeflow', kind: 'stored', apps: [
            { id: 'chat', label: 'Chat activity', always: true, collect: collectToolLedger },
            { id: 'documents', label: 'Knowledge uploads', always: true, collect: collectDocumentUploads },
        ],
    },
]);

/** Every tool a live source may call. All read-only (sideEffectMap). */
const LIVE_TOOLS = Object.freeze(new Set(SOURCE_GROUPS.flatMap((g) => g.apps.flatMap((a) => a.tools || []))));

/** @param {Iterable<string>|null|undefined} names */
function toolSet(names) {
    return new Set([...(names || [])].filter((n) => typeof n === 'string'));
}

/**
 * @param {SourceApp} app
 * @param {Set<string>} names
 */
function isConnected(app, names) {
    if (app.always) return true;
    if (app.tools) return app.tools.every((t) => names.has(t));
    const prefixes = app.connectedBy || [];
    for (const n of names) if (prefixes.some((p) => n.startsWith(p))) return true;
    return false;
}

/**
 * GET /suggest/sources: the groups with each app's connection state.
 * @param {Iterable<string>} availableToolNames
 */
function listSourceGroups(availableToolNames) {
    const names = toolSet(availableToolNames);
    return {
        windowDays: WINDOW_DAYS,
        groups: SOURCE_GROUPS.map((g) => {
            const apps = g.apps.map((a) => ({ id: a.id, label: a.label, connected: isConnected(a, names) }));
            return { id: g.id, kind: g.kind, apps, connected: apps.some((a) => a.connected) };
        }),
    };
}

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/-/g, '_');

/**
 * Which apps run. `sources` may name groups ('mail') and apps ('gmail',
 * 'google-drive'); missing or empty means everything.
 * @param {string[]|null|undefined} sources
 * @param {Set<string>} names
 * @returns {Array<{ group: SourceGroup, app: SourceApp }>}
 */
function selectUnits(sources, names) {
    const wanted = new Set((Array.isArray(sources) ? sources : []).map(norm).filter(Boolean));
    const units = [];
    for (const group of SOURCE_GROUPS) {
        for (const app of group.apps) {
            const picked = wanted.size === 0 || wanted.has(group.id) || wanted.has(app.id);
            if (picked && isConnected(app, names)) units.push({ group, app });
        }
    }
    return units;
}

/**
 * The executeTool a collector gets: only this registry's read-only tools,
 * only when the user has them, and never after the source was stopped.
 * @param {(name: string, args: object, opts?: object) => Promise<any>} executeTool
 * @param {Set<string>} names
 * @param {AbortSignal} signal
 */
function guardExecutor(executeTool, names, signal) {
    return async (name, args) => {
        if (signal.aborted) throw sourceError('aborted', 'source stopped');
        if (!LIVE_TOOLS.has(name) || isSideEffect(name)) throw sourceError('error', `tool not allowed: ${name}`);
        if (!names.has(name)) throw sourceError('not_connected', `tool not available: ${name}`);
        if (typeof executeTool !== 'function') throw sourceError('not_connected', 'no tool executor');
        return executeTool(name, args, { signal });
    };
}

/**
 * Run one collector against its time limit and the scan's abort signal.
 * Settles with the events, or rejects with a coded error; either way the
 * collector's own signal is aborted when it is no longer wanted.
 * @param {() => Promise<any[]>} run
 * @param {{ ms: number, reason: 'timeout'|'budget' }} limit
 * @param {AbortController} controller
 * @param {AbortSignal|undefined} parentSignal
 * @returns {Promise<any[]>}
 */
function runWithin(run, limit, controller, parentSignal) {
    return new Promise((resolve, reject) => {
        let settled = false;
        /** @type {ReturnType<typeof setTimeout>|undefined} */
        let timer;
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            parentSignal?.removeEventListener('abort', onAbort);
            fn(value);
        };
        const stop = (code) => {
            controller.abort();
            finish(reject, sourceError(code, code === 'aborted' ? 'scan aborted' : `${code} after ${limit.ms} ms`));
        };
        const onAbort = () => stop('aborted');
        if (parentSignal?.aborted) return stop('aborted');
        timer = setTimeout(() => stop(limit.reason), Math.max(0, limit.ms));
        parentSignal?.addEventListener('abort', onAbort, { once: true });
        Promise.resolve().then(run).then((v) => finish(resolve, v), (e) => finish(reject, e));
    });
}

const REASONS = new Set(['auth', 'error', 'timeout', 'budget', 'aborted', 'not_connected', 'shield']);

/**
 * @param {{
 *   userId: string,
 *   availableToolNames?: Iterable<string>,
 *   executeTool?: (name: string, args: object, opts?: object) => Promise<any>,
 *   sources?: string[]|null,
 *   now?: number, windowDays?: number,
 *   nextcloudUid?: string|null,
 *   deps?: { db?: any, getManualToolEvents?: Function },
 *   collectors?: Record<string, (ctx: any) => Promise<any[]>>,
 *   limits?: Partial<{ concurrency: number, perSourceMs: number, totalMs: number }>,
 * }} ctx  `deps` reach the stored collectors (tests pass pglite or fakes);
 *         `collectors` replaces a registry collector by app id (tests only).
 * @param {{ onProgress?: (step: { source: string, app: string, status: 'start'|'done'|'skipped', events: number, reason?: string }) => void,
 *           signal?: AbortSignal }} [opts]
 * @returns {Promise<{ events: any[], steps: Array<{ source: string, app: string, status: 'done'|'skipped', events: number, reason?: string }>,
 *                     reason: 'no_sources'|null }>}
 */
async function collectAll(ctx, opts = {}) {
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
    const signal = opts.signal;
    const limits = { ...LIMITS, ...(ctx.limits || {}) };
    const names = toolSet(ctx.availableToolNames);
    const units = selectUnits(ctx.sources, names);
    if (!units.length) return { events: [], steps: [], reason: 'no_sources' };

    const now = ctx.now ?? Date.now();
    const windowDays = ctx.windowDays ?? WINDOW_DAYS;
    const since = now - windowDays * DAY;
    const deadline = Date.now() + limits.totalMs;
    const pseudoDomain = mailLive.makeDomainPseudonymiser();
    const events = [];
    const steps = [];

    const emit = (step) => {
        try { onProgress(step); } catch (err) { log.warn('[RepeatingWork] onProgress threw', err); }
    };

    const runUnit = async ({ group, app }) => {
        const base = { source: group.id, app: app.id };
        const left = deadline - Date.now();
        let reason = signal?.aborted ? 'aborted' : (left <= 0 ? 'budget' : null);
        /** @type {any[]} */
        let found = [];
        if (!reason) {
            emit({ ...base, status: 'start', events: 0 });
            const controller = new AbortController();
            /** @type {{ ms: number, reason: 'timeout'|'budget' }} */
            const limit = left < limits.perSourceMs ? { ms: left, reason: 'budget' } : { ms: limits.perSourceMs, reason: 'timeout' };
            const collectorCtx = {
                userId: ctx.userId, now, since, windowDays, signal: controller.signal, pseudoDomain,
                nextcloudUid: ctx.nextcloudUid || null, deps: ctx.deps || {},
                executeTool: guardExecutor(/** @type {any} */ (ctx.executeTool), names, controller.signal),
            };
            try {
                const collect = ctx.collectors?.[app.id] || app.collect;
                const result = await runWithin(() => collect(collectorCtx), limit, controller, signal);
                found = Array.isArray(result) ? result : [];
            } catch (err) {
                const code = /** @type {any} */ (err)?.code;
                reason = REASONS.has(code) ? code : 'error';
                if (reason !== 'aborted') {
                    const msg = String(/** @type {any} */ (err)?.message || '').slice(0, 200);
                    log.warn(`[RepeatingWork] source ${group.id}/${app.id} skipped (${reason}): ${msg}`);
                }
            }
        }
        const step = reason
            ? { ...base, status: /** @type {const} */ ('skipped'), events: 0, reason }
            : { ...base, status: /** @type {const} */ ('done'), events: found.length };
        for (const e of found) events.push(e);
        steps.push(step);
        emit(step);
    };

    let next = 0;
    const worker = async () => {
        while (next < units.length) await runUnit(units[next++]);
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limits.concurrency, units.length)) }, worker));
    return { events, steps, reason: null };
}

module.exports = { SOURCE_GROUPS, LIVE_TOOLS, LIMITS, WINDOW_DAYS, listSourceGroups, collectAll, selectUnits, isConnected };
