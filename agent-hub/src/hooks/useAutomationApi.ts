import { useCallback, useMemo } from 'react';
import { API_BASE, authFetch } from '../utils/helpers';
import { readEventStream } from '../utils/sseStream';
import { fromError, type ManagedBannerInfo } from '../components/shared/managedPart';

/**
 * REST helpers for the automation builder. Thin wrapper over authFetch so
 * components don't have to repeat the URL prefix and JSON handshake.
 *
 * The returned object is memoised with useMemo so callers can use it as a
 * stable useEffect dependency. Without this, each render produced a new
 * object literal with new arrow-function members; consumers like
 * VersionHistoryPanel and WebhookPanel keyed a reload callback on `api`,
 * which then re-fired on every render and ran the browser out of sockets
 * (ERR_INSUFFICIENT_RESOURCES).
 *
 * Responses are `unknown`: this module owns the URLs and the error contract,
 * not the sixty response shapes behind them. A caller that needs a field
 * narrows it (or passes a type argument), which keeps the guess where the
 * screen using it can be read.
 */

/**
 * A failed request. `status` is always set by `send`/`stepSend`, `code` only
 * when the route sent a machine code, `retryAfter` only for a 429 scan, and
 * `details` only when the route rejected a definition with the validator's
 * structured records (the builder shows those on the canvas, BFSF-58).
 */
export interface AutomationApiError extends Error {
    status?: number;
    code?: string;
    retryAfter?: number;
    details?: unknown[];
    /**
     * Set when the stage that manages this automation refused the write (409
     * `managed_part`) or the run (409 `managed_part_not_deployed`): what the
     * ManagedPartBanner needs. A save that fails this way is not a conflict and
     * not a validation problem, and must never be retried or "kept".
     */
    managed?: ManagedBannerInfo;
}

/** `{ triggerProvider, triggerEvent? }` — narrows to the automations wired to
 *  one app-event provider. Anything else is dropped rather than sent. */
export interface AutomationListFilter {
    triggerProvider?: string;
    triggerEvent?: string;
}

export interface RunQuery {
    limit?: number;
    cursor?: string;
    automationId?: string;
    kind?: string;
    status?: string | string[];
    trigger?: string | string[];
    triggerKind?: string | string[];
    mode?: string | string[];
    since?: string;
    until?: string;
}

export interface FacetQuery {
    /** Hours of history the counts cover. */
    range?: number;
    automationId?: string;
    kind?: string;
    mode?: string | string[];
}

export interface ApprovalQuery {
    scope?: string;
    status?: string | string[];
    cursor?: string;
    limit?: number;
    appId?: string;
    automationId?: string;
    q?: string;
}

export interface RunStreamOptions {
    automationId?: string | null;
    signal?: AbortSignal;
    onEvent?: (type: string, data: unknown) => void;
}

export type SseEventHandler = (event: string, data: unknown) => void;

export default function useAutomationApi() {
    const get = useCallback(async <T = unknown>(path: string): Promise<T> => {
        const r = await authFetch(`${API_BASE}/api/automation${path}`);
        if (!r.ok) throw new Error((await safeText(r)) || `GET ${path} failed`);
        return r.json();
    }, []);

    const send = useCallback(async <T = unknown>(method: string, path: string, body?: unknown): Promise<T> => {
        const r = await authFetch(`${API_BASE}/api/automation${path}`, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
        });
        if (!r.ok) {
            // Status AND code travel with the error. A refusal is not always a
            // bad request: creating an automation from an app button answers 403
            // with a `code` saying WHOSE it would have been
            // (server/appStudio/appRefLookup.appRefOwnerVerdict), and a caller
            // that only gets a sentence has to match on prose to tell that
            // apart from "this plan does not include automations" — which is how
            // an ownership refusal ends up on screen as a billing problem.
            const { message, code, details, managed } = await errorBody(r);
            const err: AutomationApiError = new Error(message || `${method} ${path} failed`);
            err.status = r.status;
            if (code) err.code = code;
            if (details) err.details = details;
            if (managed) err.managed = managed;
            throw err;
        }
        return r.json();
    }, []);

    // Reusable Steps (kind='block') live under a sibling /api/step router.
    const stepGet = useCallback(async <T = unknown>(path: string): Promise<T> => {
        const r = await authFetch(`${API_BASE}/api/step${path}`);
        if (!r.ok) {
            // Attach status so callers can tell a 404 (feature flag off / server
            // without the /api/step routes yet) from a real failure and hide the
            // Steps tab cleanly instead of letting saves fail later.
            const err: AutomationApiError = new Error((await safeText(r)) || `GET ${path} failed`);
            err.status = r.status;
            throw err;
        }
        return r.json();
    }, []);
    const stepSend = useCallback(async <T = unknown>(method: string, path: string, body?: unknown): Promise<T> => {
        const r = await authFetch(`${API_BASE}/api/step${path}`, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
        });
        if (!r.ok) {
            const { message, code, details, managed } = await errorBody(r);
            const err: AutomationApiError = new Error(message || `${method} ${path} failed`);
            err.status = r.status;
            if (code) err.code = code;
            if (details) err.details = details;
            if (managed) err.managed = managed;
            throw err;
        }
        return r.json();
    }, []);

    return useMemo(() => ({
        // `filter` narrows to the automations wired to one app-event provider
        // (`{ triggerProvider, triggerEvent? }`, M2). Omitted → the caller's
        // whole list, byte for byte the call this used to be. The server
        // answers a provider id it does not know with a 400 rather than the
        // unfiltered list, so a typo can never widen a screen's claim.
        listAutomations: <T = unknown>(filter?: AutomationListFilter) => get<T>(`/${buildAutomationListQuery(filter)}`),
        getAutomation: <T = unknown>(id: string) => get<T>(`/${id}`),
        // Which app buttons run this automation (P4 deel C). Owner-only, and the
        // server ANSWERS AN ERROR rather than an empty list when it cannot
        // tell — so a caller must keep "nothing uses this" and "could not be
        // checked" apart. `get` throws on a non-2xx, which is exactly that
        // distinction; never map the rejection to [].
        getUsage: (id: string) => get(`/${id}/usage`),
        createAutomation: <T = unknown>(body: unknown) => send<T>('POST', '/', body),
        updateAutomation: (id: string, body: unknown) => send('PUT', `/${id}`, body),
        deleteAutomation: (id: string) => send('DELETE', `/${id}`),
        activate: (id: string) => send('POST', `/${id}/activate`),
        deactivate: (id: string) => send('POST', `/${id}/deactivate`),
        // `body` is `{ triggerPayload }` — the data the run ENTERS with. Both
        // routes have always read it; nothing ever sent one, so an automation you
        // could not fire for real (a form the visitor has not filled in yet, an
        // app_event with no matching message) started every test run with
        // `trigger.output === {}` and every step mapping off the trigger
        // resolved to undefined. BuilderShell now passes the trigger node's own
        // saved sample (BFSF-408).
        run: (id: string, body?: unknown) => send('POST', `/${id}/run`, body || {}),
        dryRun: (id: string, body?: unknown) => send('POST', `/${id}/dry-run`, body || {}),
        diagnoseTrigger: (id: string) => send('POST', `/${id}/diagnose-trigger`),
        // Executions list — cursor-paginated + filterable. Returns
        // { runs, nextCursor }. listStepRuns is the same route (a Step's runs
        // are automation_runs with automation_id = the block id).
        listRuns: (id: string, opts: RunQuery = {}) => get(`/${id}/runs${buildRunQuery(opts)}`),
        listStepRuns: (stepId: string, opts: RunQuery = {}) => get(`/${stepId}/runs${buildRunQuery(opts)}`),
        listRecentRuns: (opts: RunQuery = {}) => get(`/_runs/recent${buildRunQuery(opts)}`),
        // Facet counts for the filter chips.
        getRunFacets: (opts: FacetQuery = {}) => get(`/_runs/facets${buildFacetQuery(opts)}`),
        // The ORGANISATION-wide run log (Track H2) — separate routes, not a
        // ?scope=org on the two above, because those are user-scoped by
        // contract and half a dozen callers rely on that. Both 403 without the
        // manage_automations permission, and both 403 for an account that is
        // in no organisation; neither ever quietly narrows to "my runs". Rows
        // come back through a server-side allow-list (no trigger payloads) and
        // carry `mine`, which decides whether a row can be opened at all.
        listOrgRuns: (opts: RunQuery = {}) => get(`/_runs/org${buildRunQuery(opts)}`),
        getOrgRunFacets: (opts: FacetQuery = {}) => get(`/_runs/org/facets${buildFacetQuery(opts)}`),
        getActiveRuns: <T = unknown>() => get<T>('/_runs/active'),
        // Live run-lifecycle SSE (fetch-streamed so X-Session-Token auth applies;
        // EventSource can't set headers). Optionally scoped to one automation.
        // onEvent(type, data) is called per event; resolves when the stream ends
        // or `signal` aborts. Throws on connect failure so callers fall back.
        streamRuns: async ({ automationId = null, signal, onEvent }: RunStreamOptions = {}) => {
            const qs = automationId ? `?automationId=${encodeURIComponent(automationId)}` : '';
            const r = await authFetch(`${API_BASE}/api/automation/_runs/stream${qs}`, { signal });
            if (!r.ok || !r.body) {
                const err: AutomationApiError = new Error((await safeText(r)) || 'runs stream failed');
                err.status = r.status;
                throw err;
            }
            await readEventStream(
                r.body,
                (evt: string, data: { type?: string } | null) => onEvent?.(data?.type || evt, data),
                signal,
            );
        },
        previewSchedule: (cron: string, tz: string, count = 3) => send('POST', '/_schedule/preview', { cron, tz, count }),
        // Cross-route helpers: reusable HTTP credentials (org vault) for the
        // http_request step's Authentication picker. Live under
        // /api/integrations/connections; includeShared adds credentials lent
        // to this user (marked access:'lent'). Responses never contain the
        // secret — write-only by API contract.
        listHttpConnections: async (): Promise<unknown> => {
            const r = await authFetch(`${API_BASE}/api/integrations/connections?provider=http&includeShared=1`);
            if (!r.ok) throw new Error((await safeText(r)) || 'GET /integrations/connections failed');
            return r.json();
        },
        createHttpConnection: async (body?: unknown): Promise<unknown> => {
            const r = await authFetch(`${API_BASE}/api/integrations/connections`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body || {}),
            });
            if (!r.ok) throw new Error((await safeText(r)) || 'POST /integrations/connections failed');
            return r.json();
        },
        getRun: (runId: string) => get(`/runs/${runId}`),
        getRunSteps: (runId: string) => get(`/runs/${runId}/steps`),
        // The RUN-level first-run gate (awaiting_confirm). `decision`
        // defaults to 'approve' so a caller that passes only the id still
        // means what it always meant; `reason` is optional and only read on
        // a reject, where it lands in the run's summary. Rejecting closes
        // THIS run and leaves the gate on the automation — it does not run it.
        approveRun: (runId: string, decision = 'approve', reason?: string) => send('POST', `/runs/${runId}/approve`, { decision, reason }),
        // Run cancel + retry — wire UI buttons in RunHistory to these.
        // retryRun re-fires `executeAutomation` server-side with a
        // parent_run_id link so the history shows the lineage; cancelRun
        // flips cancel_requested in the DB and aborts the in-process
        // controller (cross-pod safe).
        retryRun: (id: string, runId: string) => send('POST', `/${id}/runs/${runId}/retry`),
        cancelRun: (runId: string) => send('POST', `/runs/${runId}/cancel`),
        approveStep: (runId: string, decision: string, reason?: string, answers?: unknown) => send('POST', `/runs/${runId}/approve-step`, { decision, reason, answers }),
        // ── Approvals section (durable decision records) ──────────────
        listApprovals: (params: ApprovalQuery = {}) => {
            const q = new URLSearchParams();
            if (params.scope) q.set('scope', params.scope);
            if (params.status) q.set('status', Array.isArray(params.status) ? params.status.join(',') : params.status);
            if (params.cursor) q.set('cursor', params.cursor);
            if (params.limit) q.set('limit', String(params.limit));
            if (params.appId) q.set('appId', params.appId);
            if (params.automationId) q.set('automationId', params.automationId);
            if (params.q) q.set('q', params.q);
            const qs = q.toString();
            return get(`/approvals${qs ? `?${qs}` : ''}`);
        },
        approvalFacets: (scope?: string) => get(`/approvals/facets${scope ? `?scope=${scope}` : ''}`),
        approvalDirectory: () => get('/approvals/directory'),
        getApproval: (id: string) => get(`/approvals/${id}`),
        decideApproval: (id: string, decision: string, reason?: string, answers?: unknown) => send('POST', `/approvals/${id}/decide`, { decision, reason, answers }),
        withdrawApproval: (id: string, reason?: string) => send('POST', `/approvals/${id}/withdraw`, { reason }),
        // Attachment downloads are plain navigations, not fetches — the
        // browser handles the attachment disposition.
        approvalFileUrl: (id: string, fileId: string) => `${API_BASE}/api/automation/approvals/${id}/files/${fileId}`,
        listVersions: (id: string) => get(`/${id}/versions`),
        getVersion: (id: string, versionId: string) => get(`/${id}/versions/${versionId}`),
        // Restore a historical version. Server validates the stored
        // definition (some step types or tool names may have been removed
        // since) and bumps the version counter so the restore itself shows
        // up as a new entry in the history.
        restoreVersion: (id: string, versionId: string) => send('POST', `/${id}/versions/${versionId}/restore`),
        // `triggerStepId` scopes the new webhook to ONE webhook-kind trigger
        // node, so an automation with several of them gets a distinct URL each.
        // The server has always validated and stored this; the client just
        // never sent it, so every webhook was primary-trigger-scoped (BFSF-320).
        // Omitted → the primary trigger, the pre-existing behaviour.
        createWebhook: (id: string, triggerStepId: string | null = null) => send('POST', `/${id}/webhook`, triggerStepId ? { triggerStepId } : {}),
        listWebhooks: (id: string) => get(`/${id}/webhooks`),
        // Webhook secret rotation invalidates the previous secret
        // immediately. The new secret is returned ONCE — surface it in the
        // UI so the user copies it before navigating away.
        rotateWebhook: (id: string, slug: string) => send('POST', `/${id}/webhook/${slug}/rotate`),
        deleteWebhook: (id: string, slug: string) => send('DELETE', `/${id}/webhook/${slug}`),
        // Hosted form pages (trigger kind 'form'). Unlike a webhook there is no
        // secret to reveal: the URL token IS the credential, so rotating mints
        // a whole new URL and the old one 404s immediately.
        createFormPage: (id: string, triggerStepId: string | null = null) => send('POST', `/${id}/form`, triggerStepId ? { triggerStepId } : {}),
        listFormPages: (id: string) => get(`/${id}/forms`),
        // Every published form in the ORGANISATION, for the Forms menu and the
        // All-forms page. Note the singular/plural trap: `/${id}/forms` above
        // is one automation's pages, `/forms` is the org's.
        listOrgForms: () => get('/forms'),
        // One form for the Form page (Studio → Forms → a form), keyed by the
        // AUTOMATION id — never the page token. The definition travels only to
        // the owner; a colleague who may read the answers gets the rest.
        getForm: (automationId: string) => get(`/forms/${automationId}`),
        // Make (or re-make) the answers table of a form that collects.
        provisionAnswersTable: (automationId: string) => send('POST', `/forms/${automationId}/answers-table`),
        // "Build it with AI": `{ mode: 'create'|'revise', brief?, note?, current? }`
        // → `{ draft: { form, notes }, mode }`. Nothing is stored — the Form
        // page applies the draft to its unsaved questions.
        draftForm: (body: unknown) => send('POST', '/forms/ai/draft', body),
        // Who may fill the form in: `{ audience: 'org'|'restricted', sharedGroups, sharedUserIds }`
        // → `{ audience: { mode, groups, users } }`. Owner only.
        setFormAudience: (automationId: string, body: unknown) => send('PUT', `/forms/${automationId}/audience`, body),
        rotateFormPage: (id: string, token: string) => send('POST', `/${id}/form/${token}/rotate`),
        deleteFormPage: (id: string, token: string) => send('DELETE', `/${id}/form/${token}`),
        getCatalog: <T = unknown>() => get<T>('/catalog'),
        // AI one-liner describing what a layer does. Opt-in (gated behind an
        // off-by-default checkbox in the Layers drawer) — stateless: we send
        // the layer mini-definition the user is looking at and get { summary }.
        summariseLayer: (layer: unknown) => send('POST', '/builder/summarise-layer', { layer }),
        // Auto-label + auto-icon: the FAST tier names steps that are still
        // unnamed (empty + not user-locked). `allowedIcons` is the client's
        // renderable icon-name set so the model can only return icons we draw.
        labelSteps: (definition: unknown, allowedIcons: string[]) => send('POST', '/builder/label-steps', { definition, allowedIcons }),
        // Design-time "Map with AI" for the parse_json step: sample + plain-
        // language instruction → deterministic field paths, verified server-
        // side against the sample. Returns { fields: [{ name, path,
        // description, verified, sampleValue? }] }.
        mapJsonFields: (sample: unknown, instruction: string, existingFields: unknown) => send('POST', '/builder/map-json-fields', { sample, instruction, existingFields }),
        // The Condition node's model FALLBACK: it runs only after the
        // offline catalogue (flow/settings/routeIntents.js) failed to
        // understand the sentence, and only when the author clicks. `fields`
        // carries NAMES ONLY — key, display name, type — never a row and
        // never a sample value: a Condition node routinely sits over customer
        // records, and personal data does not leave Bee Flow. The server
        // parses every expression it gets back with the runner's own grammar
        // and drops any that names a field we did not declare. Returns
        // { rules: [{ name, expr }], problem }.
        suggestRouteRules: (body: unknown) => send('POST', '/builder/route-rules', body),
        // "Check the sample rows" for the Condition node's "is about" rules:
        // `{ texts, labels }` → `{ texts, labels, scores, defaultThreshold }`.
        // Unlike route-rules this DOES send sample texts, on the author's
        // click, and only to the topic classifier on this server (in-cluster,
        // stores nothing): they never leave Bee Flow. 409 when no classifier
        // is installed, 503 when it does not answer.
        previewTopics: (body: unknown) => send('POST', '/builder/topic-preview', body),
        // Auto-map's AI fallback, on the wand click only, for the inputs the
        // deterministic pass left empty: `{ params, mapped, sources, step? }`
        // (sources carry bounded samples; the server shortens and masks them
        // again) → `{ suggestions: [{ key, binding, reason, sampleValue }],
        // rejected: [{ key, reason }] }`, each binding verified against the
        // samples. See Builder/mapping/aiAutoMap.ts.
        suggestMappings: (body: unknown) => send('POST', '/builder/suggest-mappings', body),
        // Curated template gallery shown in the EmptyState. listTemplates
        // returns metadata only; getTemplate fetches the full definition
        // so the builder can pre-fill via createAutomation.
        // ── Sidebar folders (org-wide, one level) ─────────────────────
        // Deleting a folder DETACHES its automations; it never deletes them,
        // which matters because a folder is shared across the organisation.
        listFolders: <T = unknown>() => get<T>('/folders'),
        createFolder: (body: unknown) => send('POST', '/folders', body),
        updateFolder: (id: string, body: unknown) => send('PUT', `/folders/${id}`, body),
        deleteFolder: <T = unknown>(id: string) => send<T>('DELETE', `/folders/${id}`),
        moveAutomationToFolder: (id: string, folderId: string | null) => send('PUT', `/${id}`, { folderId: folderId || null }),
        // Portable export/import. exportAutomation returns the scrubbed
        // envelope (never the raw row — that carries the AI transcript).
        exportAutomation: <T = unknown>(id: string) => get<T>(`/${id}/export`),
        importAutomation: <T = unknown>(body: unknown) => send<T>('POST', '/import', body),
        listTemplates: () => get('/templates'),
        getTemplate: (templateId: string) => get(`/templates/${templateId}`),
        // ── Reusable Steps (kind='block') — the /api/step router ──────
        // A Step is a standalone Flowlet (one input contract + output) built in
        // the same builder, published, then added to automations (call_block)
        // or exposed in chat. publishStep rolls the draft out to consumers.
        listSteps: <T = unknown>() => stepGet<T>('/'),
        getStep: (id: string) => stepGet(`/${id}`),
        createStep: (body: unknown) => stepSend('POST', '/', body),
        updateStep: (id: string, body: unknown) => stepSend('PUT', `/${id}`, body),
        deleteStep: (id: string) => stepSend('DELETE', `/${id}`),
        publishStep: (id: string) => stepSend('POST', `/${id}/publish`),
        setStepSharing: (id: string, body: unknown) => stepSend('PUT', `/${id}/sharing`, body),
        setStepExpose: (id: string, exposeAsTool: boolean) => stepSend('PUT', `/${id}/expose`, { exposeAsTool }),
        listStepVersions: (id: string) => stepGet(`/${id}/versions`),
        testStep: (id: string, inputs: unknown) => stepSend('POST', `/${id}/test`, { inputs }),
        // "Find repeating work" — runs a read-only scan of the user's
        // connected tools and returns automation suggestions (specs only).
        // The caller feeds a chosen suggestion's buildPrompt into the builder.
        // SSE: streams `phase` / `model` / `scan_step` / `done` / `error`
        // events (and, optionally, a future per-suggestion `suggestion` event)
        // so the UI can show a live scan log; resolves when the stream ends.
        // Pass an AbortSignal to cancel the scan (e.g. on unmount). The body's
        // `force:true` (set by Re-scan) tells the backend to bypass any
        // server-side scan cache — harmless to send before that lands.
        suggestAutomationsStream: async (body: unknown, onEvent: SseEventHandler, signal?: AbortSignal) => {
            const r = await authFetch(`${API_BASE}/api/automation/builder/suggest`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body || {}),
                signal,
            });
            if (!r.ok || !r.body) {
                // Preserve the HTTP status + Retry-After so callers can tell a
                // rate-limit cooldown (429) apart from a real failure.
                const msg = (await safeText(r)) || 'Suggestion scan failed';
                const err: AutomationApiError = new Error(msg);
                err.status = r.status;
                const ra = Number(r.headers.get('Retry-After'));
                if (Number.isFinite(ra) && ra > 0) err.retryAfter = ra;
                throw err;
            }
            await readEventStream(r.body, onEvent, signal);
        },
        // Last persisted scan for this user (server-side cache), so the section
        // can paint instantly without re-scanning. Optional endpoint — tolerate
        // 204 (no body) / 404 (route not deployed yet) by resolving to null so
        // the FE degrades gracefully before the backend lands.
        getLastScan: async (): Promise<unknown> => {
            try {
                const r = await authFetch(`${API_BASE}/api/automation/builder/suggest/last`);
                if (r.status === 204 || r.status === 404) return null;
                if (!r.ok) return null;
                const text = await r.text();
                if (!text) return null;
                try { return JSON.parse(text); } catch { return null; }
            } catch {
                return null;
            }
        },
        // Best-effort feedback signal for a suggestion ('built' | 'asked' |
        // 'dismissed'). Used to improve future ranking. Fire-and-forget:
        // swallow any error (incl. the route not existing yet) so it never
        // blocks the user's action.
        recordSuggestionFeedback: async (body: unknown) => {
            try {
                await authFetch(`${API_BASE}/api/automation/builder/feedback`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body || {}),
                });
            } catch {
                /* best-effort — never surface */
            }
        },
    }), [get, send, stepGet, stepSend]);
}

/**
 * The sentence to show, the machine code beside it when the route sent one,
 * and the validator's records when it rejected a definition.
 */
export interface ErrorBody {
    message: string;
    code: string | null;
    details: unknown[] | null;
    /** The managed-part refusal this body is, when it is one (409 managed_part[_not_deployed]). */
    managed: ManagedBannerInfo | null;
}

/**
 * One failed response, read ONCE.
 *
 * A response body can only be consumed once, so "give me the text" and "give
 * me the code" cannot be two passes. This is the single read; safeText is the
 * text half of it and keeps its old signature for the dozen callers that only
 * ever wanted a message.
 */
export async function errorBody(r: Response): Promise<ErrorBody> {
    try {
        const j = await r.json();
        const code = typeof j?.code === 'string' ? j.code : null;
        // The stage's refusals carry `details` as an object ({ solutionId, stage }),
        // which the validator-records branch below would never read.
        const managed = fromError(j);
        // Surface validator details so the user can see WHY the definition is
        // rejected. `details` is an array of structured records
        // ({code, message, hint, ...}) — render their human messages, not the
        // raw objects (which would stringify to "[object Object]").
        if (j.error && Array.isArray(j.details) && j.details.length) {
            const msgs = j.details.map(detailText).filter(Boolean);
            return { message: msgs.length ? `${j.error}: ${msgs.join('; ')}` : j.error, code, details: j.details, managed };
        }
        return { message: j.error || JSON.stringify(j), code, details: null, managed };
    } catch { return { message: r.statusText, code: null, details: null, managed: null }; }
}

export async function safeText(r: Response): Promise<string> {
    return (await errorBody(r)).message;
}

/** One validator detail as the server sends it. */
interface ValidatorDetail {
    message?: string;
    code?: string;
    hint?: string;
}

/**
 * One validator detail as a sentence — INCLUDING its hint (BFSF-348).
 *
 * Every record the server rejects a definition with carries both a `message`
 * ("Step step_7: a form step needs the automation to start with a form trigger")
 * and a `hint` ("Switch the trigger to Form, or remove this step") — the
 * message says what is wrong, the hint says what to do about it. We used to
 * drop the hint on the floor, which left the user staring at a rule with no
 * way out of it: the one actionable half of the error was fetched, parsed and
 * then discarded.
 *
 * The hint is skipped when the message already contains it, so a server that
 * spells both into `message` doesn't produce a stutter.
 */
function detailText(d: string | ValidatorDetail | null | undefined): string {
    if (typeof d === 'string') return d;
    if (!d) return '';
    const message = d.message || d.code || '';
    const hint = typeof d.hint === 'string' ? d.hint.trim() : '';
    if (!hint || message.includes(hint)) return message;
    return message ? `${message} — ${hint}` : hint;
}

// Build the executions list query string. Arrays (status/trigger/mode) are
// sent comma-separated; the server parses them back into ANY(...) filters.
function buildRunQuery(opts: RunQuery = {}): string {
    const p = new URLSearchParams();
    const csv = (v?: string | string[]) => (Array.isArray(v) ? v.filter(Boolean).join(',') : v);
    if (opts.limit != null) p.set('limit', String(opts.limit));
    if (opts.cursor) p.set('cursor', opts.cursor);
    if (opts.automationId) p.set('automationId', opts.automationId);
    if (opts.kind) p.set('kind', opts.kind);
    const status = csv(opts.status); if (status) p.set('status', status);
    const trigger = csv(opts.trigger || opts.triggerKind); if (trigger) p.set('triggerKind', trigger);
    const mode = csv(opts.mode); if (mode) p.set('mode', mode);
    if (opts.since) p.set('since', opts.since);
    if (opts.until) p.set('until', opts.until);
    const qs = p.toString();
    return qs ? `?${qs}` : '';
}

// The automations list query. Only the two app-event narrowing parameters
// exist server-side; anything else is dropped here rather than sent, so a
// caller cannot invent a filter the route would ignore.
function buildAutomationListQuery(filter?: AutomationListFilter): string {
    const p = new URLSearchParams();
    if (filter?.triggerProvider) p.set('triggerProvider', filter.triggerProvider);
    if (filter?.triggerEvent) p.set('triggerEvent', filter.triggerEvent);
    const qs = p.toString();
    return qs ? `?${qs}` : '';
}

function buildFacetQuery(opts: FacetQuery = {}): string {
    const p = new URLSearchParams();
    if (opts.range != null) p.set('range', String(opts.range));
    if (opts.automationId) p.set('automationId', opts.automationId);
    if (opts.kind) p.set('kind', opts.kind);
    const mode = Array.isArray(opts.mode) ? opts.mode.filter(Boolean).join(',') : opts.mode;
    if (mode) p.set('mode', mode);
    const qs = p.toString();
    return qs ? `?${qs}` : '';
}
