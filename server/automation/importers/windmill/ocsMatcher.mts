/**
 * A custom Windmill script that makes ONE recognisable Nextcloud call, as the
 * matching Bee Flow `nextcloud_*` action (PLAN B3 ocsMatcher.mts, research 06 §C.8).
 *
 * Works on the acorn tree of the type-stripped script, with string
 * comparisons on the literal parts of the URL; nothing is run and no regular
 * expression reads the source. Recognised call forms:
 *
 *   fetch(`${base}/ocs/…/${x}`, { method, body })
 *   axios.request({ method, url, baseURL, headers: { Destination }, data }), axios.get/put/post/delete(url, data?)
 *   client.GET/POST/PUT/DELETE("/ocs/…/{id}", { params: { path: { id } }, body })   (openapi-fetch)
 *
 * A match needs: exactly one Nextcloud call, every `${…}` of its URL a
 * parameter of `main` (or the connection's base URL / user id), and no loop.
 * The call then maps to a specific tool when its method and path are in the
 * table below, otherwise to the generic `nextcloud_request` (A6) when the
 * path names no user folder. Everything else is not a match, and the caller
 * moves on to the code shim or the AI builder.
 */

import type { WmInput } from './ir.mts';
import type { Reshape, ScriptPlan } from './plan.mts';
import type { BodyShape, NcCall, Piece } from './ncCalls.mts';
import { pathPieces, readNcCalls } from './ncCalls.mts';
import { GET_USER_MANAGER_FIELD, TOOL } from './targetNames.mts';
import type { Capabilities } from './capabilities.mts';

export function planOcs(source: string, inputs: Record<string, WmInput>, caps: Capabilities): ScriptPlan | null {
    const calls = readNcCalls(source);
    if (!calls || calls.length !== 1 || !calls[0]) return null;
    return toPlan(calls[0], inputs, caps);
}

// ── Mapping the call ─────────────────────────────────────────────────────

/** The path with each slot written as `{}` (params) or `{user}`, for matching. */
function shapeOf(pieces: Piece[]): string {
    return pathPieces(pieces).map((p) => ('text' in p ? p.text : p.slot.kind === 'user' ? '{user}' : '{}')).join('');
}

function params(pieces: Piece[]): string[] {
    return pathPieces(pieces).flatMap((p) => ('slot' in p && p.slot.kind === 'param' ? [p.slot.name] : []));
}

interface Rule { method: string; shape: string; tool: string; slots: string[]; body?: string }

const RULES: Rule[] = [
    { method: 'MKCOL', shape: '/remote.php/dav/files/{user}/{}', tool: 'nextcloud_create_folder', slots: ['path'] },
    { method: 'DELETE', shape: '/remote.php/dav/files/{user}/{}', tool: 'nextcloud_delete', slots: ['path'] },
    { method: 'GET', shape: '/remote.php/dav/files/{user}/{}', tool: 'nextcloud_read_file', slots: ['path'] },
    { method: 'PUT', shape: '/remote.php/dav/files/{user}/{}', tool: 'nextcloud_upload_file', slots: ['path'], body: 'content' },
    { method: 'PUT', shape: '/remote.php/dav/systemtags-relations/files/{}/{}', tool: 'nextcloud_tag_file', slots: ['fileId', 'tagId'] },
    { method: 'DELETE', shape: '/remote.php/dav/systemtags-relations/files/{}/{}', tool: 'nextcloud_untag_file', slots: ['fileId', 'tagId'] },
    { method: 'GET', shape: '/ocs/v2.php/cloud/users/{}', tool: TOOL.getUser, slots: ['userId'] },
    { method: 'GET', shape: '/ocs/v1.php/cloud/users/{}', tool: TOOL.getUser, slots: ['userId'] },
    { method: 'POST', shape: '/ocs/v2.php/apps/spreed/api/v1/chat/{}', tool: 'nextcloud_talk_send_message', slots: ['token'] },
    { method: 'POST', shape: '/ocs/v2.php/apps/notifications/api/v2/admin_notifications/{}', tool: 'nextcloud_notifications_send', slots: ['userId'] },
];

const COPY_MOVE: Record<string, string> = { COPY: 'nextcloud_copy', MOVE: 'nextcloud_move' };
const FILES = '/remote.php/dav/files/{user}/{}';

function toPlan(call: NcCall, inputs: Record<string, WmInput>, caps: Capabilities): ScriptPlan | null {
    const shape = shapeOf(call.pieces);
    const names = params(call.pieces);
    if (COPY_MOVE[call.method] && shape === FILES && call.destination && shapeOf(call.destination) === FILES) {
        const dest = params(call.destination);
        return toolPlan(COPY_MOVE[call.method], { source: inputs[names[0]], destination: inputs[dest[0]] }, `${call.method} over WebDAV.`);
    }
    const rule = RULES.find((r) => r.method === call.method && r.shape === shape);
    if (rule) return ruleToPlan(rule, call, names, inputs, caps);
    return genericPlan(call, inputs, caps);
}

function ruleToPlan(rule: Rule, call: NcCall, names: string[], inputs: Record<string, WmInput>, caps: Capabilities): ScriptPlan | null {
    if (rule.tool === TOOL.getUser && !caps.getUser) return null;
    const mapped: Record<string, WmInput | undefined> = {};
    rule.slots.forEach((slot, i) => { mapped[slot] = inputs[names[i]]; });
    Object.assign(mapped, bodyParams(rule, call, inputs));
    const plan = toolPlan(rule.tool, mapped, `${call.method} ${shapeOf(call.pieces)} in the script.`);
    if (plan && plan.kind === 'tool') decorate(plan, rule);
    return plan;
}

/** The request body as tool inputs: one input (upload content), or one input per body field. */
function bodyParams(rule: Rule, call: NcCall, inputs: Record<string, WmInput>): Record<string, WmInput | undefined> {
    const out: Record<string, WmInput | undefined> = {};
    if (!call.body) return out;
    if (rule.body && 'param' in call.body) out[rule.body] = inputs[call.body.param];
    if ('object' in call.body) {
        for (const [k, v] of Object.entries(call.body.object)) out[k] = 'param' in v ? inputs[v.param] : { type: 'static', value: v.literal };
    }
    return out;
}

function decorate(plan: Extract<ScriptPlan, { kind: 'tool' }>, rule: Rule): void {
    if (rule.tool === TOOL.getUser) plan.reshape = managerOnly;
    if (rule.slots.includes('tagId')) plan.repick = ['the tag (and a fixed file id)'];
}

/** Of a user profile only the manager is known to read the same in both. */
const managerOnly: Reshape = (segs) => (segs.length === 1 && segs[0].v === 'manager' ? { segs: [{ kind: 'name', v: GET_USER_MANAGER_FIELD }] } : null);

function toolPlan(tool: string, mapped: Record<string, WmInput | undefined>, reason: string): ScriptPlan | null {
    const inputs: Record<string, WmInput> = {};
    for (const [k, v] of Object.entries(mapped)) {
        if (!v) return null;
        inputs[k] = v;
    }
    return { kind: 'tool', tool, inputs, reshape: null, status: 'pattern', confidence: 'medium', reason: `The script makes one Nextcloud call (${reason})` };
}

const REQUEST_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'PROPFIND', 'REPORT', 'MKCOL', 'MOVE', 'COPY']);

function genericPlan(call: NcCall, inputs: Record<string, WmInput>, caps: Capabilities): ScriptPlan | null {
    if (!caps.request || !REQUEST_METHODS.has(call.method)) return null;
    if (call.body && 'other' in call.body) return null;
    const path = pathTemplate(pathPieces(call.pieces), inputs);
    if (!path) return null;
    const out: Record<string, WmInput> = { method: { type: 'static', value: call.method } };
    for (const name of path.names) out[`__path_${name}`] = inputs[name];
    const body = bodyInputs(call.body, inputs);
    if (!body) return null;
    if (body.param) out.body = body.param;
    return {
        kind: 'tool', tool: TOOL.request, inputs: out, fixed: { path: path.template }, objects: body.objects, reshape: null, status: 'pattern', confidence: 'medium',
        reason: `The script makes one Nextcloud call (${call.method} ${path.template}); the generic Nextcloud request makes the same call.`,
        notes: ['The generic Nextcloud request only writes to the paths Bee Flow allows; a dry run shows whether this one is among them.'],
    };
}

/** `/ocs/…/{{name}}/…` from the pieces; null when a piece names the user or a parameter without an input. */
function pathTemplate(pieces: Piece[], inputs: Record<string, WmInput>): { template: string; names: string[] } | null {
    let template = '';
    const names: string[] = [];
    for (const p of pieces) {
        if ('text' in p) {
            if (p.text.includes('{{')) return null;
            template += p.text;
            continue;
        }
        if (p.slot.kind !== 'param' || !inputs[p.slot.name]) return null;
        template += `{{${p.slot.name}}}`;
        names.push(p.slot.name);
    }
    return { template, names };
}

function bodyInputs(body: BodyShape | undefined, inputs: Record<string, WmInput>): { param?: WmInput; objects: Record<string, Record<string, WmInput>> } | null {
    if (!body) return { objects: {} };
    if ('param' in body) return inputs[body.param] ? { param: inputs[body.param], objects: {} } : null;
    if (!('object' in body)) return null;
    const fields: Record<string, WmInput> = {};
    for (const [k, v] of Object.entries(body.object)) {
        const input = 'param' in v ? inputs[v.param] : { type: 'static' as const, value: v.literal };
        if (!input) return null;
        fields[k] = input;
    }
    return { objects: { body: fields } };
}
