// @typecheck noImplicitAny
/**
 * Nextcloud Tasks Tools — VTODO over CalDAV.
 *
 * Tasks live in the same CalDAV namespace as events, just under task lists
 * that advertise VTODO in supported-calendar-component-set. Reuses 80% of
 * the calendar plumbing (auth, REPORT, ETag concurrency).
 */

const crypto = require('crypto');
const ICAL = require('ical.js');
const ncClient = require('./nextcloudClient');
const { parseMultistatusResponses, fetchLists, taskWriteError } = require('./nextcloudTasksDav');
const { NEXTCLOUD_TASKS_TOOLS } = require('./nextcloudTasksToolDefs.mts');

/** @param {string} [filterStatus] */
function todoQueryReport(filterStatus) {
    let statusFilter = '';
    if (filterStatus === 'open') {
        statusFilter = `<c:prop-filter name="STATUS"><c:text-match negate-condition="yes">COMPLETED</c:text-match></c:prop-filter>`;
    } else if (filterStatus === 'completed') {
        statusFilter = `<c:prop-filter name="STATUS"><c:text-match>COMPLETED</c:text-match></c:prop-filter>`;
    }
    return `<?xml version="1.0" encoding="utf-8" ?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VTODO">${statusFilter}</c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;
}

// ─── iCal helpers (ical.js-backed) ────────────────────────────────

/** @param {InstanceType<typeof ICAL.Time>} time */
function icsTimeToISO(time) {
    if (!time) return null;
    if (time.isDate) {
        const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
        return `${time.year}-${pad(time.month)}-${pad(time.day)}`;
    }
    return time.toJSDate().toISOString();
}

/**
 * @param {InstanceType<typeof ICAL.Component>} vtodo
 * @returns {Todo}
 */
function todoFromIcal(vtodo) {
    const get = (/** @type {string} */ n) => {
        const p = vtodo.getFirstProperty(n);
        // TEXT properties come back as strings; PRIORITY and PERCENT-COMPLETE as
        // numbers, which the parseInt below accepts as well.
        return p ? /** @type {string} */ (p.getFirstValue()) : null;
    };
    const dueProp = /** @type {InstanceType<typeof ICAL.Time>} */ (vtodo.getFirstPropertyValue('due'));
    const completedProp = /** @type {InstanceType<typeof ICAL.Time>} */ (vtodo.getFirstPropertyValue('completed'));
    const categoriesProp = vtodo.getFirstProperty('categories');
    /** @type {string[]} */
    let categories = [];
    if (categoriesProp) {
        const vals = categoriesProp.getValues();
        // CATEGORIES is comma-separated list — ical.js returns array of strings.
        categories = (Array.isArray(vals) ? vals : [vals]).filter(Boolean).map(String);
    }
    return {
        uid: get('uid') || null,
        summary: get('summary') || null,
        description: get('description') || null,
        due: dueProp ? icsTimeToISO(dueProp) : null,
        priority: parseInt(get('priority') || '0', 10) || 0,
        status: get('status') || 'NEEDS-ACTION',
        percentComplete: parseInt(get('percent-complete') || '0', 10) || 0,
        completed: completedProp ? icsTimeToISO(completedProp) : null,
        categories,
    };
}

/**
 * @typedef {{ uid: string|null, summary: string|null, description: string|null, due: string|null,
 *   priority: number, status: string, percentComplete: number, completed: string|null,
 *   categories: string[] }} Todo
 */

/** @param {string} text @returns {Todo[]} */
function parseICalTodos(text) {
    if (!text) return [];
    let jcal;
    try { jcal = ICAL.parse(text); } catch (_) { return []; }
    const root = new ICAL.Component(jcal);
    return root.getAllSubcomponents('vtodo').map(todoFromIcal);
}

/** @param {Partial<Todo>} todo */
function buildVCalendarTodo({ uid, summary, description, due, priority, status, percentComplete, completed, categories }) {
    const cal = new ICAL.Component(['vcalendar', [], []]);
    cal.updatePropertyWithValue('prodid', '-//Bee Flow//Nextcloud Tasks Tool//EN');
    cal.updatePropertyWithValue('version', '2.0');
    cal.updatePropertyWithValue('calscale', 'GREGORIAN');

    const vtodo = new ICAL.Component('vtodo');
    vtodo.updatePropertyWithValue('uid', uid);
    const now = ICAL.Time.fromJSDate(new Date(), true);
    vtodo.updatePropertyWithValue('dtstamp', now);
    vtodo.updatePropertyWithValue('created', now);
    if (summary) vtodo.updatePropertyWithValue('summary', summary);
    if (description) vtodo.updatePropertyWithValue('description', description);
    if (due) {
        const d = new Date(due);
        if (!isNaN(d.getTime())) vtodo.updatePropertyWithValue('due', ICAL.Time.fromJSDate(d, true));
    }
    if (priority !== undefined && priority !== null) vtodo.updatePropertyWithValue('priority', Number(priority));
    if (status) vtodo.updatePropertyWithValue('status', status);
    if (percentComplete !== undefined && percentComplete !== null) {
        vtodo.updatePropertyWithValue('percent-complete', Number(percentComplete));
    }
    if (completed) {
        const c = new Date(completed);
        if (!isNaN(c.getTime())) vtodo.updatePropertyWithValue('completed', ICAL.Time.fromJSDate(c, true));
    }
    if (Array.isArray(categories) && categories.length) {
        const prop = new ICAL.Property('categories', vtodo);
        prop.setValues(categories.map(String));
        vtodo.addProperty(prop);
    }

    cal.addSubcomponent(vtodo);
    return cal.toString();
}

// ─── DAV helpers ──────────────────────────────────────────────────

/** @param {string} baseUrl @param {string} uid */
function calendarsRoot(baseUrl, uid) {
    return `${baseUrl}/remote.php/dav/calendars/${encodeURIComponent(uid)}`;
}

/** @param {string} baseUrl @param {string} uid @param {string} list @param {string} todoUid */
function todoHref(baseUrl, uid, list, todoUid) {
    return `${calendarsRoot(baseUrl, uid)}/${encodeURIComponent(list)}/${encodeURIComponent(todoUid)}.ics`;
}

/** @param {string} xml */
function parseTodoMultiStatus(xml) {
    return parseMultistatusResponses(xml)
        .filter((/** @type {ReturnType<typeof parseMultistatusResponses>[number]} */ { href, props }) => href && props['calendar-data'] !== undefined)
        .map((/** @type {ReturnType<typeof parseMultistatusResponses>[number]} */ { href, props }) => ({
            href: decodeURIComponent(href),
            etag: props.getetag || null,
            calendarData: props['calendar-data'] || '',
        }));
}

// ─── Tool execution ──────────────────────────────────────────────

/**
 * @typedef {Awaited<ReturnType<typeof ncClient.resolveAuth>> & { root: string }} TasksCtx
 * @typedef {(args: Record<string, any>, c: TasksCtx) => Promise<Record<string, any>>} TasksHandler
 */

/** @param {TasksCtx} c @param {string} list @param {string} status */
function reportTodos(c, list, status) {
    return c.fetch(`${c.root}/${encodeURIComponent(list)}/`, {
        method: 'REPORT',
        headers: { 'Depth': '1', 'Content-Type': 'application/xml; charset=utf-8' },
        body: todoQueryReport(status === 'all' ? null : status),
    });
}

/** @type {TasksHandler} */
async function listLists(_args, { fetch: ncFetch, root, uid, authError }) {
    const found = await fetchLists(ncFetch, root, uid, authError);
    if (found.error) return found;
    return { count: found.lists.length, lists: found.lists };
}

/** The first writable list that supports tasks, else the first that supports them. @param {TasksCtx} c */
async function defaultList({ fetch: ncFetch, root, uid, authError }) {
    const found = await fetchLists(ncFetch, root, uid, authError);
    if (found.error) return { found };
    const list = found.lists.find((l) => l.supportsTasks && l.writable)?.slug
        || found.lists.find((l) => l.supportsTasks)?.slug;
    return { list };
}

/** @type {TasksHandler} */
async function listTasks(args, c) {
    let list = args.list;
    if (!list) {
        const picked = await defaultList(c);
        if (picked.found) return picked.found;
        list = picked.list;
        if (!list) return { error: 'No task list found. Nextcloud Tasks needs a calendar that supports tasks (VTODO); create a task list in Nextcloud first.' };
    }
    const status = args.status || 'open';
    const limit = Math.min(Math.max(args.limit || 200, 1), 1000);
    const res = await reportTodos(c, list, status);
    if (res.status === 401) return { error: c.authError };
    if (res.status === 404) return { error: `Task list not found: ${list}` };
    if (!res.ok) return { error: `Task fetch failed (${res.status})` };
    const xml = await res.text();
    const tasks = collectTodos(parseTodoMultiStatus(xml), list, limit, () => true, []);
    if (!tasks.length) {
        const found = await fetchLists(c.fetch, c.root, c.uid, c.authError);
        const entry = found.lists?.find((l) => l.slug === list);
        if (entry && !entry.supportsTasks) return { error: `Task list "${list}" does not support tasks (no VTODO). Use nextcloud_tasks_list_lists to find a list with supportsTasks true.` };
    }
    return { list, count: tasks.length, tasks };
}

/**
 * Append the todos of `items` that pass `keep` to `into`, stopping at `limit`.
 * @param {ReturnType<typeof parseTodoMultiStatus>} items @param {string} list @param {number} limit
 * @param {(t: Todo) => boolean} keep @param {Record<string, any>[]} into
 */
function collectTodos(items, list, limit, keep, into) {
    for (const item of items) {
        for (const t of parseICalTodos(item.calendarData)) {
            if (!keep(t)) continue;
            into.push({ ...t, etag: item.etag, href: item.href, list });
            if (into.length >= limit) return into;
        }
    }
    return into;
}

/** @param {Todo} t */
function todoHaystack(t) {
    return `${t.summary || ''} ${t.description || ''} ${(t.categories || []).join(' ')}`.toLowerCase();
}

/** @type {TasksHandler} */
async function searchTasks(args, c) {
    const q = String(args.query || '').toLowerCase().trim();
    if (!q) return { error: 'query is required' };
    const status = args.status || 'all';
    const limit = Math.min(Math.max(args.limit || 50, 1), 200);

    let lists = args.list ? [args.list] : null;
    if (!lists) {
        const found = await fetchLists(c.fetch, c.root, c.uid, c.authError);
        if (found.error) return found;
        lists = found.lists.filter((l) => l.supportsTasks).map((l) => l.slug);
    }

    /** @type {Record<string, any>[]} */
    const matches = [];
    for (const list of lists) {
        const res = await reportTodos(c, list, status);
        if (!res.ok) continue;
        collectTodos(parseTodoMultiStatus(await res.text()), list, limit, (t) => todoHaystack(t).includes(q), matches);
        if (matches.length >= limit) break;
    }
    return { query: args.query, count: matches.length, tasks: matches };
}

/** @type {TasksHandler} */
async function getTask(args, { baseUrl, uid, fetch: ncFetch, authError }) {
    if (!args.list || !args.uid) return { error: 'list and uid are required' };
    const res = await ncFetch(todoHref(baseUrl, uid, args.list, args.uid), {});
    if (res.status === 401) return { error: authError };
    if (res.status === 404) return { error: `Task not found: ${args.uid}` };
    if (!res.ok) return { error: `Task fetch failed (${res.status})` };
    const text = await res.text();
    const todos = parseICalTodos(text);
    return todos[0] ? { ...todos[0], etag: res.headers.get('etag'), list: args.list } : { error: 'No VTODO in response' };
}

/** @type {TasksHandler} */
async function createTask(args, { baseUrl, uid, fetch: ncFetch, authError }) {
    if (!args.list || !args.summary) return { error: 'list and summary are required' };
    const todoUid = `${crypto.randomUUID()}@${new URL(baseUrl).hostname}`;
    const ical = buildVCalendarTodo({
        uid: todoUid,
        summary: args.summary,
        description: args.description,
        due: args.due,
        priority: args.priority,
        status: 'NEEDS-ACTION',
        percentComplete: 0,
        categories: args.categories,
    });
    const res = await ncFetch(todoHref(baseUrl, uid, args.list, todoUid), {
        method: 'PUT',
        headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'If-None-Match': '*' },
        body: ical,
    });
    if (res.status === 401) return { error: authError };
    if (res.status === 404) return { error: `Task list not found: ${args.list}` };
    if (!res.ok && res.status !== 201 && res.status !== 204) {
        const body = await res.text().catch(() => '');
        return { error: taskWriteError('create', args.list, res.status, body) };
    }
    return { success: true, list: args.list, uid: todoUid, etag: res.headers.get('etag') };
}

/** @param {Record<string, any>} args @param {Partial<Todo>} current */
function mergeCompleted(args, current) {
    const completed = args.completed === false ? false : true;
    return {
        uid: args.uid,
        summary: current.summary,
        description: current.description,
        due: current.due,
        priority: current.priority,
        status: completed ? 'COMPLETED' : 'NEEDS-ACTION',
        percentComplete: completed ? 100 : 0,
        completed: completed ? new Date().toISOString() : null,
        categories: current.categories,
    };
}

/** @param {Record<string, any>} args @param {Partial<Todo>} current */
function mergeUpdate(args, current) {
    return {
        uid: args.uid,
        summary: args.summary !== undefined ? args.summary : current.summary,
        description: args.description !== undefined ? args.description : current.description,
        due: args.due !== undefined ? (args.due === '' ? null : args.due) : current.due,
        priority: args.priority !== undefined ? args.priority : current.priority,
        status: current.status || 'NEEDS-ACTION',
        percentComplete: current.percentComplete || 0,
        completed: current.completed,
        categories: args.categories !== undefined ? args.categories : current.categories,
    };
}

/**
 * Read the task, merge, and write it back under its ETag.
 * @param {Record<string, any>} args @param {TasksCtx} c
 * @param {(args: Record<string, any>, current: Partial<Todo>) => Partial<Todo>} merge
 */
async function rewriteTask(args, { baseUrl, uid, fetch: ncFetch, authError }, merge) {
    if (!args.list || !args.uid) return { error: 'list and uid are required' };
    const getRes = await ncFetch(todoHref(baseUrl, uid, args.list, args.uid), {});
    if (getRes.status === 401) return { error: authError };
    if (getRes.status === 404) return { error: `Task not found: ${args.uid}` };
    if (!getRes.ok) return { error: `Could not load task for update (${getRes.status})` };
    const currentEtag = getRes.headers.get('etag');
    /** @type {Partial<Todo>} */
    const current = parseICalTodos(await getRes.text())[0] || {};
    const merged = merge(args, current);

    const ical = buildVCalendarTodo(merged);
    const putRes = await ncFetch(todoHref(baseUrl, uid, args.list, args.uid), {
        method: 'PUT',
        headers: {
            'Content-Type': 'text/calendar; charset=utf-8',
            ...(currentEtag ? { 'If-Match': currentEtag } : {}),
        },
        body: ical,
    });
    if (putRes.status === 401) return { error: authError };
    if (putRes.status === 412) return { error: 'Task was modified by another client; refetch and retry.' };
    if (!putRes.ok && putRes.status !== 204) {
        const body = await putRes.text().catch(() => '');
        return { error: taskWriteError('update', args.list, putRes.status, body) };
    }
    return { success: true, list: args.list, uid: args.uid, etag: putRes.headers.get('etag'), status: merged.status };
}

/** @type {TasksHandler} */
async function deleteTask(args, { baseUrl, uid, fetch: ncFetch, authError }) {
    if (!args.list || !args.uid) return { error: 'list and uid are required' };
    const res = await ncFetch(todoHref(baseUrl, uid, args.list, args.uid), { method: 'DELETE' });
    if (res.status === 401) return { error: authError };
    if (res.status === 404) return { error: `Task not found: ${args.uid}` };
    if (!res.ok && res.status !== 204) return { error: `Task delete failed (${res.status})` };
    return { success: true, list: args.list, uid: args.uid };
}

/** @type {Record<string, TasksHandler>} */
const HANDLERS = {
    nextcloud_tasks_list_lists: listLists,
    nextcloud_tasks_list: listTasks,
    nextcloud_tasks_search: searchTasks,
    nextcloud_tasks_get: getTask,
    nextcloud_tasks_create: createTask,
    nextcloud_tasks_update: (args, c) => rewriteTask(args, c, mergeUpdate),
    nextcloud_tasks_complete: (args, c) => rewriteTask(args, c, mergeCompleted),
    nextcloud_tasks_delete: deleteTask,
};

/**
 * @param {string} toolName
 * @param {Record<string, any>} args tool arguments as the model sent them
 * @param {string} userId
 * @param {Partial<Express.Session> | null | undefined} session
 */
async function executeNextcloudTasksTool(toolName, args, userId, session) {
    const ctx = await ncClient.resolveAuth(session, userId);
    const handler = Object.hasOwn(HANDLERS, toolName) ? HANDLERS[toolName] : null;
    if (!handler) return { error: `Unknown Nextcloud tasks tool: ${toolName}` };
    return handler(args, { ...ctx, root: calendarsRoot(ctx.baseUrl, ctx.uid) });
}

/** @param {unknown} toolName */
function isNextcloudTasksTool(toolName) {
    return typeof toolName === 'string' && toolName.startsWith('nextcloud_tasks_');
}

module.exports = {
    NEXTCLOUD_TASKS_TOOLS,
    executeNextcloudTasksTool,
    isNextcloudTasksTool,
};
