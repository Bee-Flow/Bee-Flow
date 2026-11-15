/**
 * Windmill trigger files of a `wmill sync pull` export (research 01 §3.1, §5.1):
 *
 *   <path>.schedule.yaml                                         a schedule
 *   <script>.<flow|script>.<external id>.<service>_native_trigger.json   a native trigger
 *   <path>.<kind>_trigger.yaml                                   http, email, kafka, …
 *
 * Each reader takes the file name (already normalised) and its parsed content
 * and answers the trigger, or null when the file is not of that kind. Only the
 * fields the mapper needs are kept; an `authentication_resource_path` or a
 * header map is never copied.
 */

import type { JsonObject, WmForeignTrigger, WmNativeTrigger, WmSchedule } from './ir.mts';
import { asObject, cleanJson, isObject, str } from './util.mts';

const SCHEDULE_SUFFIXES = ['.schedule.yaml', '.schedule.yml', '.schedule.json'];
const NATIVE_SUFFIX = '_native_trigger.json';
const TRIGGER_SUFFIXES = ['_trigger.yaml', '_trigger.yml', '_trigger.json'];

function stripSuffix(name: string, suffixes: string[]): string | null {
    for (const s of suffixes) if (name.endsWith(s)) return name.slice(0, -s.length);
    return null;
}

export function readSchedule(file: string, content: unknown): WmSchedule | null {
    const base = stripSuffix(file, SCHEDULE_SUFFIXES);
    if (base === null) return null;
    const c = asObject(content);
    const cron = str(c.schedule);
    if (!cron) return null;
    const out: WmSchedule = {
        file,
        scriptPath: str(c.script_path) ?? base,
        isFlow: c.is_flow !== false,
        cron,
    };
    const tz = str(c.timezone);
    if (tz) out.timezone = tz;
    if (typeof c.enabled === 'boolean') out.enabled = c.enabled;
    if (isObject(c.args)) out.args = cleanJson(c.args) as JsonObject;
    return out;
}

export function readNativeTrigger(file: string, content: unknown): WmNativeTrigger | null {
    if (!file.endsWith(NATIVE_SUFFIX)) return null;
    const parts = file.slice(0, -NATIVE_SUFFIX.length).split('.');
    // <script path>.<flow|script>.<external id>.<service>
    const service = parts.length >= 4 ? parts[parts.length - 1] : 'unknown';
    const fromName = parts.length >= 4 ? parts.slice(0, -3).join('.') : parts.join('.');
    const c = asObject(content);
    const config = asObject(c.service_config ?? c.config);
    const out: WmNativeTrigger = {
        file,
        scriptPath: str(c.script_path) ?? fromName,
        service: str(c.service_name) ?? service,
    };
    const event = str(config.event);
    if (event) out.event = event;
    if (config.eventFilter !== undefined) out.eventFilter = cleanJson(config.eventFilter) as WmNativeTrigger['eventFilter'];
    const user = str(config.userIdFilter);
    if (user) out.userIdFilter = user;
    return out;
}

export function readForeignTrigger(file: string, content: unknown): WmForeignTrigger | null {
    if (file.endsWith(NATIVE_SUFFIX)) return null;
    const base = stripSuffix(file, TRIGGER_SUFFIXES);
    if (base === null) return null;
    const dot = base.lastIndexOf('.');
    if (dot === -1) return null;
    const c = asObject(content);
    const out: WmForeignTrigger = {
        file,
        kind: base.slice(dot + 1),
        scriptPath: str(c.script_path) ?? base.slice(0, dot),
    };
    const route = str(c.route_path);
    if (route) out.routePath = route;
    const method = str(c.http_method);
    if (method) out.httpMethod = method;
    const auth = str(c.authentication_method);
    if (auth) out.authenticationMethod = auth;
    const req = str(c.request_type);
    if (req) out.requestType = req;
    return out;
}
