/**
 * "Found in this Nextcloud": which Windmill flows listen to the org's
 * Nextcloud (PLAN B1-N1). Not part of the pure converter (../index.mts):
 * this one makes a network call.
 *
 * The server never lists Nextcloud's webhook_listeners rows itself: a
 * standalone Windmill keeps its webhook token in a row's address, and every
 * row has credentials. The org's connector (2.1.0+) reads them at service
 * level and answers `POST /hooks/windmill-inventory` with a summary from an
 * allow-list (nextcloud-connector/src/windmillInventory.js):
 *
 *   { ok: true, items: [{ generation, workspace, path, kind, events: { <class>: <event id> | null }, hasEventFilter }] }
 *
 * The call is the service-level pattern of appStudio/nextcloudMenuSync.js:
 * the callback URL and the tenant key from the pairing
 * (auth/connector/connectorTarget.mts), signed by ncSigning.js with no
 * Nextcloud uid, through nextcloudFetch (the Nextcloud host gate). No user is
 * impersonated.
 *
 * Outcomes:
 *   ok             the connector answered; `items` checked again here
 *   no_listeners   the connector answered that webhook_listeners is off, so no
 *                  Windmill trigger can exist either
 *   not_connected  the org has no paired connector
 *   unsupported    404, or 401/403/429 (an older connector has no such hook
 *                  and AppAPI refuses the call): "update the Bee Flow app"
 *   unreachable    a network error, a time-out, a 5xx or ok:false otherwise
 *
 * toInventoryResponse turns `items` into the route's answer: flows only (a
 * script on its own is not imported), each with the Bee Flow events it would
 * start on (exact through the connector's table, otherwise the converter's
 * approximation, eventClasses.mts); unknown classes are left out.
 */

import { createRequire } from 'node:module';
import { eventForClass } from '../eventClasses.mts';
import { resolveConnectorTarget } from '../../../../auth/connector/connectorTarget.mts';
import type { ConnectorTarget } from '../../../../auth/connector/connectorTarget.mts';

const nodeRequire = createRequire(import.meta.url);

export const INVENTORY_HOOK_PATH = '/hooks/windmill-inventory';
const TIMEOUT_MS = 8_000;
const MAX_ITEMS = 500;
const MAX_TEXT = 512;

export type Generation = 'flow_exapp' | 'standalone';

export interface InventoryItem {
    generation: Generation;
    workspace: string;
    path: string;
    kind: 'flow' | 'script';
    events: Record<string, string | null>;
    hasEventFilter: boolean;
}

export type InventoryOutcome =
    | { outcome: 'ok', items: InventoryItem[] }
    | { outcome: 'no_listeners' | 'not_connected' | 'unsupported' | 'unreachable', detail?: string };

export interface InventoryFlow {
    path: string;
    summary: string;
    events: string[];
    active: boolean;
}

export interface InventoryResponse {
    available: boolean;
    generation?: Generation;
    flows: InventoryFlow[];
}

type FetchLike = (url: string, init: Record<string, unknown>) => Promise<{ ok: boolean, status: number, json: () => Promise<unknown> }>;

export interface InventoryDeps {
    resolveTarget: (orgId: string) => Promise<ConnectorTarget | null>;
    fetch: FetchLike;
    sign: (args: { tenantKey: string, method: string, path: string, ncUid: string, body: string }) => Record<string, string>;
}

function defaultDeps(): InventoryDeps {
    const { nextcloudFetch } = nodeRequire('../../../../utils/nextcloudTarget.js') as { nextcloudFetch: FetchLike };
    const { signedConnectorHeaders } = nodeRequire('../../../../auth/connector/ncSigning.js') as { signedConnectorHeaders: InventoryDeps['sign'] };
    return { resolveTarget: resolveConnectorTarget, fetch: nextcloudFetch, sign: signedConnectorHeaders };
}

function isObject(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

function text(v: unknown): string | null {
    return typeof v === 'string' && v !== '' && v.length <= MAX_TEXT ? v : null;
}

/** One item of the connector's answer, checked; null for anything else. */
export function checkItem(raw: unknown): InventoryItem | null {
    if (!isObject(raw)) return null;
    const generation = raw.generation === 'flow_exapp' || raw.generation === 'standalone' ? raw.generation : null;
    const kind = raw.kind === 'flow' || raw.kind === 'script' ? raw.kind : null;
    const workspace = text(raw.workspace);
    const path = text(raw.path);
    if (!generation || !kind || !workspace || !path || !isObject(raw.events)) return null;
    const events: Record<string, string | null> = {};
    for (const [cls, id] of Object.entries(raw.events)) {
        if (!text(cls)) continue;
        events[cls] = text(id);
    }
    return { generation, workspace, path, kind, events, hasEventFilter: raw.hasEventFilter === true };
}

function statusOutcome(status: number): 'unsupported' | 'unreachable' {
    return status === 404 || status === 401 || status === 403 || status === 429 ? 'unsupported' : 'unreachable';
}

/** Ask the org's connector which Windmill flows listen to its Nextcloud. Never throws. */
export async function fetchWindmillInventory(orgId: string, deps: InventoryDeps = defaultDeps()): Promise<InventoryOutcome> {
    let target: ConnectorTarget | null;
    try {
        target = await deps.resolveTarget(orgId);
    } catch (e) {
        return { outcome: 'unreachable', detail: (e as Error).message };
    }
    if (!target) return { outcome: 'not_connected' };
    // No key named like a route parameter of Nextcloud's proxy (`appId`,
    // `other`): see the trap in appStudio/nextcloudMenuSync.js.
    const body = JSON.stringify({ reason: 'windmill_import', sentAt: new Date().toISOString() });
    let res: Awaited<ReturnType<FetchLike>>;
    try {
        res = await deps.fetch(`${target.callbackUrl}${INVENTORY_HOOK_PATH}`, {
            method: 'POST',
            headers: {
                ...deps.sign({ tenantKey: target.tenantKey, method: 'POST', path: INVENTORY_HOOK_PATH, ncUid: '', body }),
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            body,
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    } catch (e) {
        return { outcome: 'unreachable', detail: (e as Error).name === 'TimeoutError' ? 'timeout' : (e as Error).message };
    }
    if (!res.ok) return { outcome: statusOutcome(res.status), detail: `HTTP ${res.status}` };
    const data = await res.json().catch(() => null);
    if (!isObject(data)) return { outcome: 'unreachable', detail: 'not JSON' };
    if (data.ok !== true) {
        return data.error === 'webhook_listeners_disabled' ? { outcome: 'no_listeners' } : { outcome: 'unreachable', detail: text(data.error) ?? 'ok:false' };
    }
    const items = (Array.isArray(data.items) ? data.items.slice(0, MAX_ITEMS) : []).map(checkItem).filter((i): i is InventoryItem => i !== null);
    return { outcome: 'ok', items };
}

/** The flow's name for the list: the last part of its Windmill path. */
function summaryOf(path: string): string {
    const last = path.split('/').filter(Boolean).pop() || path;
    return last.split('_').join(' ');
}

/** The Bee Flow events a flow listens on, exact or approximate, without duplicates. */
function beeFlowEvents(events: Record<string, string | null>): string[] {
    const out = new Set<string>();
    for (const [cls, id] of Object.entries(events)) {
        const event = id ?? eventForClass(cls)?.event ?? null;
        if (event) out.add(event);
    }
    return [...out];
}

/**
 * The route's answer for the connector's items. The connector reports the
 * rows that exist now, and Windmill keeps them registered while the trigger is
 * on, so a listed flow is active. With both generations present the
 * standalone one is named (the Flow app is the older one).
 */
export function toInventoryResponse(items: InventoryItem[]): InventoryResponse {
    const flowItems = items.filter((i) => i.kind === 'flow');
    const byPath = new Map<string, InventoryFlow>();
    for (const item of flowItems) {
        const key = `${item.generation}\n${item.workspace}\n${item.path}`;
        const known = byPath.get(key);
        const events = beeFlowEvents(item.events);
        if (known) known.events = [...new Set([...known.events, ...events])];
        else byPath.set(key, { path: item.path, summary: summaryOf(item.path), events, active: true });
    }
    const generation: Generation | undefined = flowItems.some((i) => i.generation === 'standalone') ? 'standalone'
        : (flowItems.length ? 'flow_exapp' : undefined);
    return { available: true, ...(generation ? { generation } : {}), flows: [...byPath.values()] };
}
