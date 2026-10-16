/**
 * The payload contract, pinned against the server's OWN source.
 *
 * client.ts casts `res.json()` blindly to the caller's type, so a server-side
 * rename never throws — it turns into `undefined` somewhere in a screen, weeks
 * later, on a phone nobody is watching. The types in src/features/&#42;/types.ts
 * all say "taken from the server's own row definitions", but a claim nothing
 * checks is a comment. This test checks it: for every payload the phone cannot
 * afford to be wrong about, the EXPECTED field list is pinned here and looked
 * up in the server file that actually serialises it.
 *
 * Same family as routes.test.ts (pin expectations, read the real tree) and
 * catalogLockstep.test.ts (reach across the monorepo into server/ — works in
 * CI because the checkout is the whole repo, and the mobile CI job fires on
 * server/&#42;&#42; for exactly this reason). The server files are read as TEXT, not
 * require()d: unlike componentSpecs.js they import the database pool, and a
 * contract test must not need Postgres to say whether a field still exists.
 *
 * Additive changes stay green ON PURPOSE. The whole upgrade programme promises
 * additivity ("only add fields, never rename — mobile reads this payload"), so
 * these lists freeze the EXISTING keys and say nothing about new ones. When a
 * test here goes red, the answer is almost never to edit the list — it is to
 * put the field back and add the new name beside it.
 */

import fs from 'node:fs';
import path from 'node:path';

import { AGENT_FRAMES } from '@/shared/stream/adapters/agent';
import { WEBPAGE_FRAMES } from '@/shared/stream/adapters/webpage';
import { accounts } from '@/shared/stream/chatFrameReducer';

import { GUARD_KINDS } from './deleteGuard';

const SERVER = path.resolve(__dirname, '../../../../server');

function read(rel: string): string {
    return fs.readFileSync(path.join(SERVER, rel), 'utf8');
}

/** Concatenated source of every non-test .js file under a server directory. */
/** The agent table's DDL: initSchema.js composes the steps in initSchema.base.js and .agents.js. */
function agentSchema(): string {
    // Literal paths: serverClosure.test.ts finds the server files mobile reads by these strings.
    return [read('stores/agent/initSchema.js'), read('stores/agent/initSchema.base.js'), read('stores/agent/initSchema.agents.js')].join('\n');
}

function readTree(rel: string): string {
    const chunks: string[] = [];
    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules') continue;
                walk(full);
            } else if (entry.name.endsWith('.js') && !entry.name.includes('.test.')) {
                chunks.push(fs.readFileSync(full, 'utf8'));
            }
        }
    };
    walk(path.join(SERVER, rel));
    return chunks.join('\n');
}

/**
 * The source of ONE function: from its `function name(` to the next top-level
 * declaration (or end of file). Coarse, and deliberately so — it survives the
 * function being reformatted, but not the function being renamed away, which
 * is the failure it exists to catch.
 *
 * The terminator matches `async function` too. It did not always, and that was
 * a hole: in a store whose declarations are all async (projectStore.js) a slice
 * ran on to the END OF THE FILE, so a field deleted from ONE mapper was still
 * "found" in the next mapper down and the pin stayed green over a broken
 * payload.
 */
function functionSlice(source: string | readonly string[], fnName: string): string {
    if (typeof source !== 'string') return functionSlice(holding(source, `function ${fnName}(`), fnName);
    const start = source.indexOf(`function ${fnName}(`);
    if (start === -1) return '';
    const nested = nestedEnd(source, start);
    if (nested !== null) return nested;
    const rest = source.slice(start + 1);
    const next = rest.search(/\n(?:async )?function /);
    return source.slice(start, next === -1 ? undefined : start + 1 + next);
}

/**
 * The split stores and routers declare their functions and handlers INSIDE a
 * factory or a `registerXRoutes(router)` function, indented. The top-level
 * terminators above never see a sibling there, so a slice would run on to the
 * end of the factory and beyond — the hole the `async function` fix closed,
 * reopened. An indented declaration ends at the first line that closes at its
 * own indentation (`    }` / `    });`). Answers null for a top-level one,
 * which keeps its terminator.
 */
function nestedEnd(source: string, start: number): string | null {
    const lineStart = source.lastIndexOf('\n', start) + 1;
    const indent = /^[ \t]*/.exec(source.slice(lineStart, start))?.[0] ?? '';
    if (indent === '') return null;
    const close = source.slice(start).search(new RegExp(`\\n${indent}\\}`));
    return source.slice(start, close === -1 ? undefined : start + close + indent.length + 2);
}

/**
 * A module split into files, one source per file, for functionSlice and
 * routeSlice to pick the one holding their marker. Plain path literals, so
 * src/meta/serverClosure.test.ts sees every file read.
 */
function readSplit(...rels: string[]): string[] {
    return rels.map(read);
}

/**
 * Of a module split into files, the ONE file that holds `marker` ('' when
 * none does) — so a slice never runs from one file into the next.
 */
function holding(sources: readonly string[], marker: string): string {
    return sources.find((src) => src.includes(marker)) ?? '';
}

/** Which keys does a mapper's body assign? A superset is fine — the pinned
 *  list must be CONTAINED in it, so extra matches cost nothing.
 *
 *  Two spellings count: `key: value`, and the shorthand `key` standing on
 *  its own between `{`/`,` and `,`/`}` — `{ id, mine, ... }` across lines,
 *  or `{ summarySnippet }` inside a spread. The forms list assigns `mine`
 *  and the transcription mapper assigns `summarySnippet` that way, and a
 *  matcher that only knew `key:` reported both as missing while they were
 *  there. Line comments are dropped first so a commented-out name does not
 *  count. */
function assignedKeys(slice: string): Set<string> {
    const code = slice.replace(/\/\/.*$/gm, '');
    const explicit = [...code.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*:/g)].map((m) => m[1] as string);
    const shorthand = [...code.matchAll(/[{,]\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?=[,}])/g)].map((m) => m[1] as string);
    return new Set([...explicit, ...shorthand]);
}

/** Fields the pinned list expects that the mapper no longer assigns. */
function missingFrom(slice: string, expected: readonly string[]): string[] {
    const keys = assignedKeys(slice);
    return expected.filter((f) => !keys.has(f));
}

/** Tokens (word-bounded) a file or tree no longer mentions at all. */
function absentTokens(source: string, expected: readonly string[]): string[] {
    return expected.filter((t) => !new RegExp(`\\b${t}\\b`).test(source));
}

/**
 * Which keys does a BUILDER-style mapper put on its OUTPUT object?
 *
 * `assignedKeys` cannot answer this for a mapper that does not return one
 * literal. shapeActionItem builds `const out = { … }` and then hangs the
 * optional fields on it with `out.x = …`, and every one of those names is ALSO
 * a local binding (`const destination = shapeDestination(raw.destination)`) or
 * a `raw.x` read. A word-token check over such a slice is vacuous: rename the
 * OUTGOING key and the token stays, because the local that feeds it kept the
 * old name. Measured, not assumed — `out.destination`→`out.target`,
 * `out.segmentIndex`→`out.lineIndex` and `out.orphaned`→`out.stale` all left
 * this file's pin green.
 *
 * So look at the two places a key can be born and nowhere else:
 *   1. `out.<key> =` — the conditional tail.
 *   2. the entries of the `const out = { … }` literal, matched at line starts
 *      so a `//` comment line inside the literal cannot masquerade as a key
 *      (and cannot swallow the entry that follows it either).
 * A superset is still fine — the pinned list must be CONTAINED in the result.
 */
function outputKeys(slice: string, objectName = 'out'): Set<string> {
    const keys = new Set<string>();
    const assigned = new RegExp(`\\b${objectName}\\.([A-Za-z_][A-Za-z0-9_]*)\\s*=[^=]`, 'g');
    for (const m of slice.matchAll(assigned)) keys.add(m[1] as string);

    const decl = slice.search(new RegExp(`\\b${objectName}\\s*=\\s*\\{`));
    if (decl !== -1) {
        const open = slice.indexOf('{', decl);
        let depth = 0;
        let end = slice.length;
        for (let i = open; i < slice.length; i += 1) {
            if (slice[i] === '{') depth += 1;
            else if (slice[i] === '}') {
                depth -= 1;
                if (depth === 0) { end = i; break; }
            }
        }
        const literal = slice.slice(open + 1, end);
        for (const m of literal.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*[,:]/gm)) keys.add(m[1] as string);
    }
    return keys;
}

/** Fields the pinned list expects that the mapper no longer puts on its output. */
function missingOutput(slice: string, expected: readonly string[], objectName = 'out'): string[] {
    const keys = outputKeys(slice, objectName);
    return expected.filter((f) => !keys.has(f));
}

describe('the server tree', () => {
    it('is present, so nothing below can pass vacuously', () => {
        // A checkout without server/ (or a moved server/) must fail loudly
        // here, not let twelve payload tests "pass" on empty strings.
        expect(fs.existsSync(path.join(SERVER, 'index.js'))).toBe(true);
    });
});

describe('cowork payloads (server/stores/coworkStore.js)', () => {
    // Mirrored by CoworkSchedule in src/features/cowork/model/types.ts. The plan for
    // this store is explicitly additive ("Alleen velden toevoegen, niets
    // hernoemen — mobile leest deze payload"); this is that promise, enforced.
    const source = read('stores/coworkStore.js');

    it('rowToSchedule still maps every field the phone renders', () => {
        expect(
            missingFrom(functionSlice(source, 'rowToSchedule'), [
                'id', 'userId', 'title', 'prompt', 'repeatInterval', 'daysOfWeek',
                'timeOfDay', 'nextRunAt', 'lastRunAt', 'lastResult', 'lastStatus',
                'isActive', 'modelTier', 'runCount', 'timezone', 'agentId',
                'conversationId', 'createdAt',
            ]),
        ).toEqual([]);
    });

    it('rowToRun still maps the run history row', () => {
        expect(
            missingFrom(functionSlice(source, 'rowToRun'), [
                'id', 'scheduleId', 'userId', 'status', 'triggerKind',
                'startedAt', 'finishedAt', 'durationMs', 'result', 'error',
            ]),
        ).toEqual([]);
    });
});

describe('automation payloads (server/stores/automationStore/rowMappers.js)', () => {
    // Mirrored by Automation / AutomationRun / AutomationRunStep in
    // src/features/automations/model/types.ts, which names this exact file as its source.
    const source = read('stores/automationStore/rowMappers.js');

    it('rowToAutomation still maps every field the phone renders', () => {
        expect(
            missingFrom(functionSlice(source, 'rowToAutomation'), [
                'id', 'userId', 'organizationId', 'projectId', 'folderId', 'kind',
                'title', 'description', 'definition', 'version', 'isActive',
                'isDraft', 'needsFirstRunConfirm', 'triggerType', 'scheduleCron',
                'scheduleTz', 'nextRunAt', 'lastRunAt', 'lastStatus',
                'runningInstanceId', 'runningStartedAt', 'icon',
                'createdAt', 'updatedAt',
            ]),
        ).toEqual([]);
    });

    it('rowToAutomation still carries the live split the flow editor reads (handoff 5)', () => {
        // liveVersion/neverLive/pendingChanges decide the flow editor's Make vN
        // live (flow-editor/components/build/liveState.ts). pendingChanges is
        // only there when the query selected it: a save's answer leaves it out.
        expect(functionSlice(source, 'rowToAutomation')).toContain('...liveFields(r),');
        expect(missingFrom(functionSlice(source, 'liveFields'), ['liveVersion', 'liveAt', 'neverLive', 'pendingChanges'])).toEqual([]);
        expect(functionSlice(source, 'liveFields')).toContain("...(r.pending_changes !== undefined ? { pendingChanges:");
    });

    it('rowToRun still maps every field the run screens read', () => {
        expect(
            missingFrom(functionSlice(source, 'rowToRun'), [
                'id', 'automationId', 'version', 'userId', 'triggerKind',
                'triggerPayload', 'mode', 'status', 'startedAt', 'finishedAt',
                'durationMs', 'error', 'summary', 'parentRunId', 'rootRunId',
                'cancelRequested', 'awaitingStepId', 'awaitingStepExpiresAt',
                'errorClass', 'handledErrorCount',
            ]),
        ).toEqual([]);
    });

    it('rowToRunStep still maps every field the timeline reads', () => {
        expect(
            missingFrom(functionSlice(source, 'rowToRunStep'), [
                'runId', 'stepId', 'parentStepId', 'stepType', 'attempts',
                'status', 'startedAt', 'finishedAt', 'input', 'output',
                'error', 'errorClass', 'branchIndex',
            ]),
        ).toEqual([]);
    });
});

describe('notification rows (server/stores/notificationStore.js)', () => {
    // The route answers `SELECT *`, so the TABLE is the payload. Mirrored by
    // AppNotification in src/features/notifications/model/types.ts; `category`,
    // `task_id` and `link` are everything the tap-routing runs on.
    const source = read('stores/notificationStore.js');

    it('still selects whole rows and still has every column the phone reads', () => {
        expect(source).toContain('SELECT * FROM notifications');
        expect(
            absentTokens(source, [
                'id', 'user_id', 'task_id', 'category', 'title',
                'message', 'link', 'read', 'created_at',
            ]),
        ).toEqual([]);
    });
});

describe('conversation list rows (server/stores/agent/directConversations.js)', () => {
    // Mirrored by ConversationSummary in src/features/chat/model/types.ts. The list
    // SELECT names its columns, so the pin is on that projection.
    it('listDirectConversations still selects every column the sidebar reads', () => {
        const slice = functionSlice(read('stores/agent/directConversations.js'), 'listDirectConversations');
        expect(
            absentTokens(slice, [
                'id', 'title', 'model_tier', 'project_id', 'shared_scope',
                'pinned', 'labels_json', 'created_at', 'updated_at',
            ]),
        ).toEqual([]);
    });
});

describe('agent rows (server/stores/agent/initSchema.js)', () => {
    // Agents come back as (parsed) whole rows; the schema is the payload.
    // Mirrored by Agent in src/features/agents/model/types.ts. `starter_prompts`
    // must stay string-or-array (parseConfig deliberately does not parse it —
    // parseStarterPrompts on the phone handles both).
    it('still declares every agent column the phone reads', () => {
        expect(
            absentTokens(agentSchema(), [
                'name', 'description', 'avatar', 'model', 'owner_id',
                'is_published', 'starter_prompts', 'threads_enabled',
                'copy_enabled', 'workspace_enabled', 'embed_enabled', 'config',
                'organization_id', 'shared_groups', 'category_id', 'rev',
            ]),
        ).toEqual([]);
    });
});

describe('knowledge base payloads (server/routes/knowledgeBases/)', () => {
    // Mirrored by KnowledgeBase / KbDocument / KbChunk in
    // src/features/knowledge/model/types.ts. shared.js states the rule in its own
    // words: "Additive only — every snake_case field mobile reads is left
    // exactly where it was." This holds it to that.
    it('still serves every snake_case field the library screens read', () => {
        expect(
            absentTokens(readTree('routes/knowledgeBases'), [
                'document_count', 'total_chunks', 'chunk_count',
                'source_type', 'remote_only', 'is_published',
            ]),
        ).toEqual([]);
    });
});

describe('the pre-auth setup document (server/auth/login/setupRoutes.js)', () => {
    // GET /auth/setup-status — the document the login screen branches on
    // before any session exists (src/features/onboarding/api/readers.ts SetupStatus).
    // A missing field here does not crash the phone; it silently mis-routes
    // sign-in, which is worse.
    it('still answers every field the login flow branches on', () => {
        expect(
            absentTokens(read('auth/login/setupRoutes.js'), [
                'isSetupComplete', 'isOAuthConfigured', 'isGoogleConfigured',
                'isMicrosoftConfigured', 'deploymentMode', 'branding',
                'allowSignups', 'allowPasswordLogin', 'waitlistEnabled',
                'consumerLoginMethods',
            ]),
        ).toEqual([]);
    });
});

describe('the version probe (server/routes/healthSchema.js)', () => {
    // checkServerSupport in src/core/api/server.ts treats a 404 from
    // /api/health/schema as "older than MIN_SERVER_BUILD" — which is only
    // sound while the endpoint exists and keeps this shape on every newer
    // server. Renaming any of these breaks the app's ability to SAY a server
    // is too old.
    it('still answers { ok, schemaReady, build }', () => {
        expect(absentTokens(read('routes/healthSchema.js'), ['ok', 'schemaReady', 'build'])).toEqual([]);
    });
});

describe('the direct-chat request body (server/routes/ai/directChat/)', () => {
    // The phone SENDS these (SendTurnPayload in src/features/chat/model/types.ts);
    // the server destructures them out of req.body (streamTurn.js line 1 of
    // the handler, memoryWriteEnabled in finalizeTurn.js). A field the server
    // stops reading fails silently — the toggle in the UI would still render
    // and do nothing.
    it('still reads every field the composer sends', () => {
        expect(
            absentTokens(readTree('routes/ai/directChat'), [
                'message', 'conversationId', 'modelTier', 'history',
                'attachments', 'webSearchEnabled', 'memoryWriteEnabled',
                'projectId', 'timezone', 'activeSkillIds', 'reasoningEffort',
                'knowledgeBaseIds',
            ]),
        ).toEqual([]);
    });
});

describe('persisted chat turns (finalizeTurn.js, direct chat and agent runtime)', () => {
    // Read back by readMessage in src/features/chat/api/readers.ts UNDER THESE NAMES.
    // It used to read `tools` and `sources`, names the server never saved, so
    // a reopened chat lost its tool steps and citations with no error anywhere.
    it('the direct chat still saves toolHistory, thinking and images on the answer', () => {
        // finalizeTurn.js builds the saved rows in finalizeRows.js.
        const source = read('routes/ai/directChat/finalizeRows.js');
        expect(missingOutput(source, ['toolHistory', 'thinking', 'images'], 'assistantSave')).toEqual([]);
        // The parts of `thinking`, an image's `url`, and the turn's date.
        expect(absentTokens(source, ['text', 'redacted', 'url', 'mimeType', 'timestamp'])).toEqual([]);
    });

    it('the agent runtime still saves kbSources, toolHistory and thinking on the answer', () => {
        const source = read('core/agentRuntime/finalizeTurn.js');
        expect(missingOutput(source, ['kbSources', 'toolHistory', 'thinking'], 'assistantMsg')).toEqual([]);
    });
});

describe('the conversation and label PATCH bodies (routes/ai/directChat/conversationRoutes.js)', () => {
    // Both schemas are `.strict()`: a key the phone sends that they do not list
    // is a 400. updateConversation / updateLabel in src/features/chat/api/endpoints.ts
    // are typed to exactly these.
    const source = read('routes/ai/directChat/conversationRoutes.js');
    const schema = (name: string) => {
        const start = source.indexOf(`const ${name} = z.object({`);
        return start === -1 ? '' : source.slice(start, source.indexOf('.strict()', start));
    };

    it('ConversationPatch still accepts every key the phone sends', () => {
        expect(missingFrom(schema('ConversationPatch'), ['title', 'pinned', 'labels', 'knowledgeBaseIds'])).toEqual([]);
    });

    it('labels are still patched through the partial of LabelBody', () => {
        expect(source).toContain('const LabelPatch = LabelBody.partial();');
        expect(missingFrom(schema('LabelBody'), ['name', 'color'])).toEqual([]);
    });
});

describe('the chat stream events (server/routes/ai/ + server/core/dlp/)', () => {
    // useChatStream.ts routes on these names. Unknown events are ignored by
    // design (additive is safe), but a RENAMED event is a feature that
    // silently stops: rename `dlp_preview` and every phone hangs mid-turn
    // with no error, because the client never learns there is a decision to
    // answer. Quoted occurrences, so a prose mention cannot satisfy the pin.
    const stream = readTree('routes/ai') + readTree('core/dlp');

    it('still emits every event name the phone routes on', () => {
        const events = [
            'content', 'conversation_created', 'title', 'done', 'error',
            'dlp_preview', 'dlp_resolved', 'kb_sources', 'tool_start',
            'tool_end', 'model_selected', 'turn_busy',
        ];
        const gone = events.filter((e) => !stream.includes(`'${e}'`) && !stream.includes(`"${e}"`));
        expect(gone).toEqual([]);
    });
});

describe('the mount points (server/index.js)', () => {
    // Where the phone's paths attach. The routers read as if mounted at the
    // root, so these strings in index.js ARE the public paths — moving one
    // breaks every request to that feature at once. /api/chat/dlp-decision is
    // the one whose loss is quietest: the stream keeps flowing, and the
    // answer to the DLP question has nowhere to go.
    it('still mounts every prefix the phone calls', () => {
        const source = read('index.js');
        for (const mount of [
            '/api/health',
            '/agents',
            '/api/notifications',
            '/api/cowork',
            '/api/automation',
            '/api/kb',
            '/api/chat/dlp-decision',
        ]) {
            expect(source).toContain(`'${mount}'`);
        }
    });
});

/**
 * The source of ONE express handler: from `router.<verb>('<path>'` to the next
 * top-level `router.`. functionSlice cannot see these — a route handler is an
 * argument, not a declaration — but the same coarseness applies: reformatting
 * survives, moving the handler away does not.
 */
function routeSlice(source: string | readonly string[], marker: string): string {
    if (typeof source !== 'string') return routeSlice(holding(source, marker), marker);
    const start = source.indexOf(marker);
    if (start === -1) return '';
    // Registered inside a function (`registerFormRoutes(router)`): indented,
    // so it ends where it closes, not at a top-level `router.`.
    const nested = nestedEnd(source, start);
    if (nested !== null) return nested;
    const rest = source.slice(start + marker.length);
    const next = rest.search(/\nrouter\./);
    return source.slice(start, next === -1 ? undefined : start + marker.length + next);
}

/**
 * A route registered with a NAMED handler (`router.get('/x', mw, H.list);`)
 * keeps its body in a handler module: the registration plus that function's
 * source from `handlers`. An inline handler is just its routeSlice.
 */
function routeHandlerSlice(router: string, marker: string, handlers: readonly string[]): string {
    const registration = routeSlice(router, marker);
    const line = registration.slice(0, registration.indexOf('\n') === -1 ? undefined : registration.indexOf('\n'));
    const named = /,\s*(?:[A-Za-z_$][\w$]*\.)?([A-Za-z_$][\w$]*)\);\s*$/.exec(line);
    return named ? `${registration}\n${functionSlice(handlers, named[1] as string)}` : registration;
}

/** Every `onEvent('x'` / `sendEvent('x'` literal in a chunk of server source. */
function emittedEventNames(source: string): string[] {
    const found = [...source.matchAll(/\b(?:onEvent|sendEvent)\s*\??\.?\(\s*'([a-zA-Z_0-9]+)'/g)];
    return [...new Set(found.map((m) => m[1] as string))].sort();
}

describe('skill rows (server/stores/skillStore.js)', () => {
    // Mirrored by Skill in src/features/skills/model/types.ts, which says in its own
    // header that it was written from `mapRow` rather than from the routes —
    // both GET routes hand back exactly what mapRow produces, so mapRow IS the
    // payload and the empty-string/`⚡` defaults it applies are load-bearing.
    // skillStore.js is split by concern under stores/skill/ (rows, reads, usage).
    const store = readSplit('stores/skillStore.js', 'stores/skill/rows.js', 'stores/skill/reads.js', 'stores/skill/usage.js');
    const source = store.join('\n');

    it('mapRow still maps every field the skill screens render', () => {
        expect(
            missingFrom(functionSlice(store, 'mapRow'), [
                'id', 'orgId', 'userId', 'name', 'description', 'instructions',
                'workflow', 'rules', 'examples', 'icon', 'isShared',
                'dynamicActivation', 'sharedGroups', 'automationId',
                'enabledIntegrations', 'createdAt', 'updatedAt',
            ]),
        ).toEqual([]);
    });

    it('still decides canEdit per row, and both GET routes ask for it', () => {
        // The phone must render a shared skill it may not save as read-only,
        // and it can only know that if the row says so: `canEdit` is computed
        // by canEditSkill and stapled on per row by _withViewer (the camelCase
        // twin of withCanEdit in routes/agents/published.js:23-29). Losing the
        // viewer on either route does not fail — it hands the phone rows with
        // NO canEdit at all, and an undefined verdict is the fail-OPEN answer:
        // an editor rendered over a skill the server will 403 on save.
        // Pinned as the two stapling sites, not as a bare token: functionSlice
        // cannot fence _withViewer (the next declaration is `async function`,
        // which its `\nfunction ` terminator does not see), and `canEdit`
        // as a word also matches `canEditSkill` — so a rename of either
        // ASSIGNMENT would slip past a token check while breaking the payload.
        expect(source).toMatch(/\.\.\.s,\s*canEdit:\s*canEditSkill\(/);      // list rows
        expect(source).toMatch(/\.\.\.skill,\s*canEdit:\s*canEditSkill\(/);  // one row

        // Anchored on the path alone, not on `async`: middleware in front of
        // the handler (validate({ query: NoQuery }) since 2026-09-23) moved
        // `async` along and turned the old marker into a miss. The closing
        // quote plus comma is what keeps these off '/usage-summary' and
        // '/:id/usage'.
        const routes = read('routes/skills.js');
        expect(routeSlice(routes, "router.get('/',")).toContain('viewerOf(req)');
        expect(routeSlice(routes, "router.get('/:id',")).toContain('viewerOf(req)');
    });

    it('updateSkill still skips the facet whose text did not change', () => {
        // THE mobile compat rule, and the one with the widest blast radius.
        // app/skills/[id].tsx PUTs the whole SkillDraft (draftFromSkill in
        // src/features/skills/model/types.ts), so a rename ships `workflow`, `rules`
        // and `examples` back unchanged. resolveBodyWrite reparses text into
        // structure, and parseWorkflowToSteps returns `refs: []` with freshly
        // minted step ids (server/core/skills/skillStructure.js:131-138). Only
        // this one guard — unchanged text means the facet is left alone —
        // stops every rename on a phone from wiping the refs a Studio user
        // attached and renumbering every step. Nothing else pins it: the
        // structured store tests cover the CHANGED-text branch and the rename,
        // never the full-snapshot PUT with unchanged text.
        const slice = functionSlice(store, 'updateSkill');
        expect(slice).not.toEqual('');
        expect(slice).toMatch(/if\s*\(\s*textSent\s*&&[\s\S]{0,200}?\)\s*continue\s*;/);
    });
});

describe('webpage rows (server/stores/webpage/shared.js)', () => {
    // Mirrored by the Webpage type behind the publishing screens; mapWebpageRow
    // is the single mapper both the list and the detail route run rows through.
    const source = read('stores/webpage/shared.js');

    it('mapWebpageRow still maps every field the publishing screens render', () => {
        expect(
            missingFrom(functionSlice(source, 'mapWebpageRow'), [
                'id', 'userId', 'name', 'description', 'tagline', 'icon',
                'accentColor', 'isPublished', 'sharedGroups', 'organizationId',
                'projectId', 'htmlSize', 'cssSize', 'jsSize', 'sourceCount',
                'createdAt', 'updatedAt',
            ]),
        ).toEqual([]);
    });

    it('still derives isPublished as a BOOLEAN', () => {
        // The phone renders a published/draft badge straight off this field and
        // does not coerce. Postgres hands `is_published` back as a boolean and
        // some drivers as 't', which is why the comparison is explicit — but
        // the shape is what matters here: let this become the raw column and a
        // driver returning the STRING 'f' makes every draft read as published,
        // because a non-empty string is truthy. Pinned as the expression, not
        // as the key, because only the expression carries the boolean promise.
        expect(functionSlice(source, 'mapWebpageRow')).toContain('r.is_published === true');
    });
});

describe('transcription rows (server/stores/transcription/rowShape.js)', () => {
    // Mirrored by TranscriptionSummary in src/features/recording/model/types.ts. The
    // three spread-in fields are conditional BY DESIGN (list payloads only, and
    // absent rather than empty when a query did not select them), so they are
    // pinned as assignments here — the optional `?:` on the phone matches.
    it('mapRow still maps every field the recording list renders', () => {
        expect(
            // transcriptionStore.js is the barrel; the row shape is built in
            // transcription/rowShape.js (createRowShape -> mapRow).
            missingFrom(functionSlice(read('stores/transcription/rowShape.js'), 'mapRow'), [
                'id', 'title', 'fileName', 'language', 'durationSeconds',
                'speakerCount', 'segmentCount', 'status', 'provider', 'source',
                'isPublished', 'sharedGroups', 'organizationId',
                'createdAt', 'updatedAt',
                'tags', 'transcriptSnippet', 'summarySnippet',
            ]),
        ).toEqual([]);
    });
});

describe('the 409 delete guards (src/core/api/deleteGuard.ts)', () => {
    // One reader for four routes, and per route the query string that gets
    // past the guard. Both halves live on the server and both fail quietly: a
    // renamed body field turns every refusal into "the check did not answer",
    // and a renamed or re-typed flag turns "Delete for good" into a 400 — or
    // into a request the guard refuses again, for ever, which is how deleting
    // a recording from the phone was broken in the first place.
    const IN_USE_BODY = ["code: 'in_use'", 'usage:', 'unchecked'];

    /** The `KINDS` a usage module scans, as the unreadable-answer fallback reads them. */
    function frozenKinds(source: string): string[] {
        const list = source.match(/const KINDS = Object\.freeze\(\[([^\]]*)\]\)/)?.[1] ?? '';
        return [...list.matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
    }

    it('recordings: the in_use body, and ?confirm=1 read as a flag', () => {
        const slice = routeSlice(read('routes/transcriptions/noteActions.js'), "router.delete('/:id',");
        for (const token of IN_USE_BODY) expect(slice).toContain(token);
        expect(slice).toContain('req.query.confirm === true');
        expect(read('routes/transcriptions/noteActions.js')).toMatch(/DeleteQuery = z\.object\(\{ confirm: flag\(/);
        // `flag` is what turns the phone's '1' into that `true`.
        expect(read('routes/transcriptions/schemas.js')).toMatch(/const flag = [^\n]*'1'[\s\S]{0,120}v === '1'/);
    });

    it('knowledge bases: the in_use body, and ?confirm=1 compared as a string', () => {
        const slice = routeSlice(read('routes/knowledgeBases/detail.js'), "router.delete('/:id',");
        for (const token of IN_USE_BODY) expect(slice).toContain(token);
        expect(slice).toContain("req.query.confirm === '1'");
    });

    it('skills: the in_use body, and ONLY ?confirmBreaking=true confirms', () => {
        const source = read('routes/skills.js');
        const slice = routeSlice(source, "router.delete('/:id',");
        for (const token of IN_USE_BODY) expect(slice).toContain(token);
        expect(slice).toContain('confirmedBreaking(req)');
        expect(functionSlice(source, 'confirmedBreaking')).toContain("req.query?.confirmBreaking === 'true'");
        // The strict query schema is why `confirm=1` cannot be used here.
        expect(source).toMatch(/confirmBreaking: z\.enum\(\['true', 'false'\]/);
    });

    it('webpages: the in_use body, and ?confirm=1 read as a flag', () => {
        const lifecycle = read('routes/webpages/lifecycle.js');
        expect(routeSlice(lifecycle, "router.delete('/:id',")).toContain('req.query.confirm === true');
        expect(lifecycle).toMatch(/DeleteQuery = z\.object\(\{ confirm: flag\(/);
        const guard = read('routes/webpages/deleteGuard.js');
        for (const token of IN_USE_BODY) expect(guard).toContain(token);
    });

    it('every fallback kind the phone names is one the server still scans', () => {
        // Containment, not equality — a kind the server ADDS still arrives
        // through `unchecked` by name. A kind the phone names that the server
        // no longer scans is the stale direction, and that is what fails here.
        const scanned = {
            recording: frozenKinds(read('core/meetingNotes/meetingUsage.js')),
            knowledgeBase: frozenKinds(read('core/kb/kbUsage.js')),
            webpage: frozenKinds(read('core/webpages/webpageUsage.js')),
        };
        for (const [resource, kinds] of Object.entries(scanned)) {
            expect({ resource, found: kinds.length > 0 }).toEqual({ resource, found: true });
            const phone = GUARD_KINDS[resource as keyof typeof scanned];
            expect({ resource, stale: phone.filter((k) => !kinds.includes(k)) }).toEqual({ resource, stale: [] });
        }
        const skillUsage = functionSlice(read('stores/skill/usage.js'), 'listSkillUsage');
        for (const kind of GUARD_KINDS.skill) expect(skillUsage).toContain(`kind: '${kind}'`);
    });
});

describe('the form list (server/routes/automation/forms.js GET /forms)', () => {
    // Mirrored by FormSummary in src/features/forms/model/types.ts, which names
    // this handler as its source. Assembled inline in the route rather than by
    // a row mapper, so the slice is the handler.
    // Registered on crud.js's router by registerFormRoutes (forms.js).
    const source = read('routes/automation/forms.js');
    const slice = routeSlice(source, "router.get('/forms'");

    it('still assembles every field the forms screen renders', () => {
        expect(slice).not.toEqual('');
        expect(
            missingFrom(slice, [
                'id', 'url', 'automationId', 'triggerStepId', 'title',
                'description', 'live', 'submissions', 'lastSeenAt',
                'createdAt', 'mine',
            ]),
        ).toEqual([]);
    });

    it('still lives at /api/automation/forms', () => {
        // src/features/forms/api/endpoints.ts calls the absolute path. The list is
        // an explicit promise of the upgrade plan, and it is two halves that
        // move independently: the router-relative path here, and the mount in
        // index.js. Losing either one 404s the whole Forms tab.
        expect(source).toContain("'/forms'");
        expect(read('routes/automation/crud.js')).toContain('registerFormRoutes(router);');
        expect(read('index.js')).toContain("'/api/automation'");
    });
});

describe('project rows (server/stores/project/projects.js, project/rows.js)', () => {
    // Mirrored by Project in src/features/projects/model/types.ts. `permission` is
    // list-only (the detail route calls it `role`) and is computed by the
    // SELECT's CASE, so it is part of this mapper's contract, not the table's.
    // Each list row is the shared project mapper (mapProjectRow, which
    // getProject uses too) plus `permission`, so the mapped fields are the
    // union of both functions.
    it('listUserProjects still maps every field the solution screens read', () => {
        // projectStore.js is the barrel: the list query is in project/projects.js,
        // the shared mapper in project/rows.js.
        const list = functionSlice(read('stores/project/projects.js'), 'listUserProjects');
        expect(list).toContain('mapProjectRow(row)');
        expect(
            missingFrom(list + functionSlice(read('stores/project/rows.js'), 'mapProjectRow'), [
                'id', 'name', 'description', 'customInstructions',
                'knowledgeBaseIds', 'color', 'icon', 'ownerId',
                'organizationId', 'extractMemories', 'version', 'permission',
                'createdAt', 'updatedAt',
            ]),
        ).toEqual([]);
    });
});

describe('the agent endpoints the phone calls', () => {
    it('/agents/published still answers a BARE ARRAY', () => {
        // src/features/agents/api.ts:60 does `api.get<Agent[]>` and then
        // `for (const agent of published ?? [])`. The cast is a lie the
        // compiler cannot catch, so wrapping this in `{ agents: [...] }` gets
        // as far as the for-of and throws "published is not iterable" —
        // failing the WHOLE agent list, including the caller's own agents that
        // came back perfectly well from the other half of the Promise.all.
        const slice = routeSlice(read('routes/agents/published.js'), "router.get('/published'");
        expect(slice).not.toEqual('');
        expect(slice).toContain('res.json(await withCanEdit(');
        expect(slice).not.toContain('res.json({');
    });

    it('/agents/:id/tools still answers {componentId, params} rows', () => {
        // src/features/agents/api.ts:81 types the response as AgentTool[] and
        // reads `componentId` to resolve a component name. The grants an agent
        // holds live in `config` (server/core/agentRuntime/toolPolicy.js:6-7
        // says so in as many words: config.tools sits NEXT TO
        // enabledIntegrations), NOT in the agent_tools row — so reshaping this
        // row to carry policy would break the phone for nothing it needs.
        expect(
            missingFrom(functionSlice(read('stores/agent/agentTools.js'), 'getAgentToolsWithParams'), [
                'componentId', 'params',
            ]),
        ).toEqual([]);

        const slice = routeSlice(read('routes/agents/crud.js'), "router.get('/:id/tools'");
        expect(slice).not.toEqual('');
        expect(slice).toContain('getAgentToolsWithParams');
        expect(slice).toContain('res.json(toolsWithParams)');
    });

    it('still stores avatar and starter_prompts as TEXT', () => {
        // src/features/agents/model/avatar.ts can only tell an emoji from a data:
        // URI, an http(s) URL and a '/'-relative path. Anything else renders as
        // its own characters, so an icon NAME would show the word; and
        // parseStarterPrompts JSON.parses a string — a column that starts
        // handing back a parsed object instead makes it throw. Both are TEXT
        // today and both mobile readers depend on that staying true.
        const schema = agentSchema();
        expect(schema).toContain('avatar TEXT');
        expect(schema).toContain('starter_prompts TEXT');
    });
});

describe('meeting action items (server/core/meetingNotes/actionItems.js)', () => {
    // features/recording/model/actionItems.ts sends the WHOLE list back on every tick
    // of a checkbox, rebuilding each item with a spread — so any field the
    // server drops here is gone from the note at the first tap on a phone, and
    // it is gone for the web client too. That makes this file's shaping rules
    // part of the mobile contract even though no mobile screen writes them.
    const source = read('core/meetingNotes/actionItems.js');

    it('still hangs `destination` on the ITEM, from a closed allow-list', () => {
        // A destination is a RECEIPT for one action, not a property of the
        // note: two items in one note can go to two different places. And the
        // kind list is closed on purpose (BFSF-441 — what travels outward is a
        // reference: kind + id + label, never the action's text).
        expect(source).toContain("DESTINATION_KINDS = Object.freeze(['automation', 'datatable_row', 'kb'])");

        // Pinned on the OUTGOING keys, not on word tokens. Every one of these
        // names also exists inside shapeActionItem as a local const or a
        // `raw.<name>` read, so a token check said "still there" while the key
        // the phone reads had been renamed away — three renames stayed green
        // under the old pin (see outputKeys above). What the phone loses when
        // one of these stops being an ITEM key: `destination` → the chip on
        // every action item disappears at the first checkbox tap, because
        // features/recording/model/actionItems.ts sends the whole list back through a
        // spread; `source` → mergeRegeneratedActionItems can no longer tell an
        // AI item from one a person wrote, so the next "Regenerate" eats it.
        expect(
            missingOutput(functionSlice(source, 'shapeActionItem'), [
                'id', 'text', 'source', 'done', 'aiText', 'orphaned', 'segmentIndex', 'destination',
            ]),
        ).toEqual([]);
    });

    it('reads OUTPUT keys, not names that merely occur in the function', () => {
        // Anti-vacuity guard for the pin above. `body` is the local that feeds
        // `text:`, and `raw`/`reject` are all over the slice; if any of them
        // counted as an output key, outputKeys would be a token check wearing a
        // better name and the pin above would be worth nothing.
        const keys = outputKeys(functionSlice(source, 'shapeActionItem'));
        expect(keys.has('destination')).toBe(true);
        expect([...keys].filter((k) => ['body', 'raw', 'reject', 'strict'].includes(k))).toEqual([]);
    });

    it('regenerate still replaces only the AI items', () => {
        // Regenerating the notes must not delete what a person added or
        // edited; mergeRegeneratedActionItems is the only thing that keeps
        // them. With sources reduced to one value there is no "mine" left to
        // protect, and a regenerate silently eats the user's own action items.
        expect(source).toContain("ACTION_SOURCES = Object.freeze(['ai', 'user'])");
        expect(source).toContain('function mergeRegeneratedActionItems(');
    });
});

describe('every stream event the server emits', () => {
    // The block above pins the events the phone ALREADY routes — which by
    // construction can never notice a NEW event. This is the same pin turned
    // around: every `onEvent('x'`/`sendEvent('x'` literal in the agent runtime
    // and in the routes that serve an SSE stream must be accounted for in
    // the agent adapter, either as a handler (routed), as an IGNORE entry
    // (a decision), or here in NOT_YET_HANDLED (a
    // decision recorded on this side). Three ways to say yes, no way to say
    // nothing — the catalogLockstep NOT_YET_BUILT pattern. `tool_confirm`
    // shipped in the A-track and fell through to `default: onUnhandled` for
    // months precisely because nothing asked this question.
    //
    // `routes/agents` is in the scan because THAT is the endpoint the phone
    // opens: useAgentChatStream.ts posts to /agents/:id/chat/stream, served
    // by routes/agents/chat.js — which emits three names of its own (:382
    // title_generated, :391 done, :400 error). Leaving it out was a real hole,
    // not a scope choice: `title_generated` occurs nowhere else in server/, so
    // renaming it there (or adding any new event beside it) left this test
    // green while the phone's `case 'title_generated':` went dead and every
    // Android chat kept the title "New Chat". Measured: with the rename in
    // place the whole mobile suite was 596/596 green.
    const stream = readTree('core/agentRuntime') + readTree('routes/ai') + readTree('routes/agents');
    // The phone's side is the agent adapter's table (shared/stream/adapters/
    // agent.ts): an entry is either a handler (routed) or IGNORE (a decision).
    const routed = (event: string) => accounts(AGENT_FRAMES, event);

    /**
     * Events the phone knowingly does not touch. Every entry is a decision,
     * not a backlog item — but a NEW name may never be added here without
     * looking at what it carries.
     */
    const NOT_YET_HANDLED = [
        // A different SSE endpoint entirely (routes/ai/automationBuilder/
        // suggestions.js — the web builder's integration scan). The phone does
        // not open that stream at all. Its per-tool `scan_step` frames are
        // sent from server/automation/patterns/ideation.js now, outside the
        // tree this test reads, so they are no longer listed here.
        'model',
        // Agent-runtime telemetry: which test-mode the turn ran in and what
        // the sandbox withheld. Studio surface with no mobile screen behind
        // it. (How the prompt tokenised, the raw answer, the persona rule
        // that fired and a built `file` used to sit here too; the answer's
        // anatomy routes all four now — shared/stream/answer/frames.ts.)
        'test_as',
        'test_chat',
        'test_sandbox',
        // The agent TEST-RUNNER stream (routes/agents/tests.js:680/700/773):
        // one `start` for the run, then a `test_start`/`test_result` pair per
        // test. It is a Studio surface — the phone never opens
        // /agents/:id/tests/run, so routing them would be routing frames that
        // cannot arrive. They are listed rather than dropped so that the day a
        // mobile test screen appears, this list is the place that says nobody
        // has looked at them yet.
        'start',
        'test_start',
        'test_result',
        // `tool_confirm` used to sit here with a TODO(Z2-3). Z2-3 landed: it is
        // now an explicit IGNORE entry in the agent adapter, so keeping
        // it here would be a stale decision hiding behind a green test. The
        // "no entry here is also routed" test below is what enforces that.
        //
    ];

    it('is either routed by the phone, ignored on purpose, or listed here', () => {
        const unaccounted = emittedEventNames(stream).filter(
            (e) => !routed(e) && !NOT_YET_HANDLED.includes(e),
        );
        expect(unaccounted).toEqual([]);
    });

    it('finds enough events to be meaningful', () => {
        // Break the extraction regex (or move the runtime) and every name
        // disappears, which would make the test above pass on nothing.
        expect(emittedEventNames(stream).length).toBeGreaterThan(20);
    });

    it('lists only events that are really emitted', () => {
        // The other direction: an entry that no longer matches any emitter is
        // either a rename nobody followed, or dead weight hiding the real gap.
        const emitted = emittedEventNames(stream);
        expect(NOT_YET_HANDLED.filter((e) => !emitted.includes(e))).toEqual([]);
    });

    it('lists no event the phone already routes', () => {
        // The third direction, and the one that keeps this list honest. An
        // entry that has since grown a `case` is a decision the code has moved
        // past: the list still says "nobody has looked at this", the reader
        // believes it, and the entry goes on covering for the NEXT name that
        // gets parked here. `tool_confirm` was exactly that for one stage.
        expect(NOT_YET_HANDLED.filter((e) => routed(e))).toEqual([]);
    });

    it('covers the stream the phone actually opens', () => {
        // Guard on the scan itself, not on its result. The three tests above
        // are only worth what `stream` contains, and the file that serves
        // /agents/:id/chat/stream slipped out of it once already. Moving that
        // handler to another tree is not an error anywhere — it just makes the
        // scan quietly stop covering the phone's own endpoint again.
        expect(emittedEventNames(readTree('routes/agents'))).toContain('title_generated');
        expect(read('routes/agents/chat.js')).toContain("router.post('/:id/chat/stream'");
        expect(routed('title_generated')).toBe(true);
    });
});

describe('the flow editor (server/routes/automation/*, routes/ai/automationBuilder)', () => {
    // Mirrored by src/features/flow-editor/api (endpoints, readers and the
    // types they name). The request bodies are pinned as hard as the
    // responses: every schema here is `.strict()`, so a key the phone sends
    // and the server stops reading is a 400 on every save, not a silently
    // dropped field.
    const crud = read('routes/automation/crud.js');
    // Registered on crud.js's router (registerFolderRoutes,
    // registerTemplateAndImportRoutes, registerExportRoute).
    const folders = read('routes/automation/folders.js');
    const importExport = read('routes/automation/importExport.js');
    const catalog = read('routes/automation/catalog.js');
    // The ai_step's agent and skill previews, registered on the catalog router.
    const agentSteps = read('routes/automation/agentStepRoutes.js');
    const versions = read('routes/automation/versions.js');
    const runs = read('routes/automation/runs.js');
    // The run bodies runs.js validates with (split out of it).
    const runSchemas = read('routes/automation/runSchemas.js');
    const links = read('routes/automation/webhooksAndRunOps.js');
    const activate = read('routes/automation/activate.js');
    // GET /:id/counts, registered inside makeActionsRouter.
    const actions = read('routes/automation/actions.js');
    const chatStream = read('routes/ai/automationBuilder/chatStream.js');
    // The turn's body schema (turnSetup.js) and its closing write (turnClosing.js).
    const turnSetup = read('routes/ai/automationBuilder/turnSetup.js');
    const turnClosing = read('routes/ai/automationBuilder/turnClosing.js');

    /** A top-level `const <name> = …` declaration, up to the next top-level statement. */
    function declSlice(source: string, name: string): string {
        const start = source.indexOf(`const ${name} =`);
        if (start === -1) return '';
        const rest = source.slice(start + 1);
        const next = rest.search(/\n(?:const|function|router\.|async function|module\.exports)\b/);
        return source.slice(start, next === -1 ? undefined : start + 1 + next);
    }

    it('still serves every route the editor calls, in the file it calls it in', () => {
        const routes: [string, string][] = [
            [crud, "router.get('/:id'"],
            [crud, "router.put('/:id', validate({ body: UpdateAutomationBody })"],
            [crud, "router.post('/', validate({ body: CreateAutomationBody })"],
            [crud, "router.delete('/:id'"],
            [crud, "router.get('/:id/usage'"],
            [importExport, "router.get('/:id/export'"],
            [importExport, "router.post('/import'"],
            [crud, "router.post('/:id/activate'"],
            [crud, "router.post('/:id/publish', validate({ body: PublishBody })"],
            [crud, "router.post('/:id/deactivate'"],
            [actions, "router.get('/:id/counts'"],
            [importExport, "router.get('/templates'"],
            [importExport, "router.get('/templates/:id'"],
            [folders, "router.get('/folders'"],
            [folders, "router.post('/folders', validate({ body: FolderBody })"],
            [folders, "router.put('/folders/:folderId', validate({ body: FolderPatch })"],
            [folders, "router.delete('/folders/:folderId'"],
            [catalog, "router.get('/catalog'"],
            [catalog, "router.get('/catalog/form-pick-sources'"],
            [catalog, "router.get('/catalog/nextcloud-tables/:tableId/columns'"],
            [agentSteps, "router.get('/catalog/agent/:agentId'"],
            [versions, "router.get('/:id/versions'"],
            [versions, "router.get('/:id/versions/:versionId'"],
            [versions, "router.get('/:id/versions/:versionId/diff/:otherVersionId'"],
            [versions, "router.post('/:id/versions/:versionId/restore'"],
            [runs, "router.post('/:id/dry-run'"],
            [runs, "router.post('/:id/steps/:stepId/run', runTriggerLimiter, validate({ body: PartialRunBody })"],
            [links, "router.post('/:id/webhook'"],
            [links, "router.get('/:id/webhooks'"],
            [links, "router.post('/:id/webhook/:slug/rotate'"],
            [links, "router.delete('/:id/webhook/:slug'"],
            [links, "router.post('/:id/form'"],
            [links, "router.get('/:id/forms'"],
            [links, "router.post('/:id/form/:token/rotate'"],
            [links, "router.delete('/:id/form/:token'"],
            [chatStream, "router.post('/stream'"],
            [read('routes/ai/automationBuilder/sessionSnapshot.js'), "router.get('/session/:automationId'"],
        ];
        expect(routes.filter(([source, marker]) => !source.includes(marker)).map(([, marker]) => marker)).toEqual([]);
        // folders.js and importExport.js serve only through crud.js's router.
        for (const call of ['registerFolderRoutes(router);', 'registerTemplateAndImportRoutes(router);', 'registerExportRoute(router);']) {
            expect(crud).toContain(call);
        }
        // agentStepRoutes.js serves under /api/automation only through the catalog router.
        expect(catalog).toContain("require('./agentStepRoutes').registerAgentStepRoutes(router);");
        // actions.js serves under /api/automation through the automation router.
        expect(read('routes/automation.js')).toContain("router.use(require('./automation/actions').makeActionsRouter());");
        expect(read('index.js')).toContain("app.use('/api/automation/builder'");
    });

    it('PUT and POST still read every key the editor sends', () => {
        // FlowPatch (api/types.ts) and the create body (api/definition.ts, via
        // the automations feature's CreateAutomationBody).
        expect(missingFrom(declSlice(crud, 'UpdateAutomationBody'), [
            'title', 'description', 'definition', 'isDraft', 'triggerType', 'scheduleCron', 'scheduleTz', 'folderId',
        ])).toEqual([]);
        expect(missingFrom(declSlice(crud, 'CreateAutomationBody'), [
            'title', 'description', 'definition', 'triggerType', 'scheduleCron', 'scheduleTz', 'createdFromChatId',
        ])).toEqual([]);
        expect(missingFrom(declSlice(folders, 'FolderBody'), ['name', 'icon', 'color'])).toEqual([]);
    });

    it('a save and an activation still answer { automation, warnings } or 400 { details }', () => {
        const put = routeSlice(crud, "router.put('/:id'");
        expect(put).toContain("res.status(400).json({ error: 'Invalid definition', details:");
        // The saved row goes out through projectForViewer (automation/access.js):
        // the same row plus the caller's role on it, still under `automation`.
        expect(put).toContain('res.json({ automation: projectForViewer(updated, access), warnings: saveWarnings');
        expect(routeSlice(crud, "router.post('/',")).toContain('res.json({ automation: a, answers');
        // Activation checks in checkBeforeLive and answers with its verdict.
        // The checks themselves moved to automation/goLive.js
        // (checkBeforeLiveCore); the route passes the refusal's status and
        // body through, and an invalid definition is still 400 { error, details }.
        expect(functionSlice(activate, 'checkBeforeLive')).toContain('return { ok: false, status: r.status, body: r.body };');
        expect(read('automation/goLive.js')).toContain("refuse(400, 'invalid_definition', 'Invalid definition', { error: 'Invalid definition', details: v.errors })");
        // A refusal goes out as its own status and body (answerRefusal), a
        // success as { automation, warnings }.
        const activation = functionSlice(activate, 'activateAutomation');
        expect(activation).toContain('if (!r.ok) return answerRefusal(res, r);');
        expect(functionSlice(activate, 'answerRefusal')).toContain('return res.status(r.status).json(r.body);');
        expect(activation).toContain('res.json({ automation: forViewer(r.automation, access), warnings: r.warnings });');
        expect(routeSlice(versions, "router.post('/:id/versions/:versionId/restore'")).toContain('res.json({ automation: projectForViewer(updated, access), restoredFromVersion: version.version');
        expect(routeSlice(importExport, "router.get('/:id/export'")).toContain('res.json({ envelope, warnings })');
        expect(routeSlice(importExport, "router.post('/import'")).toContain('res.json({ automation: a, warnings:');
    });

    it('Make vN live still takes the version on screen and answers like activation (handoff 5)', () => {
        // publishAutomation (automations/api/endpoints.ts) sends `{ version }` or `{}`.
        const body = declSlice(crud, 'PublishBody');
        expect(missingFrom(body, ['version'])).toEqual([]);
        expect(body).toContain('.strict()');
        const publish = functionSlice(activate, 'publishAutomation');
        // The same pre-live checks as activation, so a refusal reads the same.
        expect(publish).toContain('const verdict = await checkBeforeLive(req, a, def, deps);');
        expect(publish).toContain('if (!verdict.ok) return res.status(verdict.status).json(verdict.body);');
        expect(publish).toContain('res.json({ automation: forViewer(u, access), warnings: verdict.warnings });');
        // isVersionChanged (flow-editor/api/definition.ts): a 409 with this code.
        expect(publish).toContain('return res.status(409).json({');
        expect(publish).toContain("code: 'version_changed'");
        // The publish answer re-reads the row, pendingChanges included, so the
        // banner clears on it (lifecycle.publishWorkingCopy -> selectOne).
        expect(functionSlice(read('stores/automationStore/lifecycle.js'), 'publishWorkingCopy')).toContain('return selectOne(id);');
    });

    it('the counts still carry the pending figure a save leaves out', () => {
        // readAutomationCounts (automations/api/readers.ts).
        expect(actions).toContain('res.json({ ...counts, pendingChanges: a.pendingChanges ?? 0 });');
    });

    it('the test runs still take the modes the editor sends and answer the rows it reads', () => {
        // STEP_RUN_MODES in src/features/flow-editor/api/types.ts.
        expect(runs).toContain("require('./runSchemas')");
        expect(runs).toContain('validate({ body: PartialRunBody })');
        const partial = declSlice(runSchemas, 'PartialRunBody');
        for (const mode of ['only', 'from', 'upTo']) expect(partial).toContain(`'${mode}'`);
        expect(missingFrom(declSlice(runSchemas, 'RUN_SHAPE'), ['triggerPayload', 'triggerStepId'])).toEqual([]);
        expect(routeSlice(runs, "router.post('/:id/dry-run'")).toContain('res.json({ run, steps })');
        expect(routeSlice(runs, "router.post('/:id/steps/:stepId/run'")).toContain('res.json({ run, steps, stepRecord })');
    });

    it('the catalog still answers every section and action field the editor reads', () => {
        const slice = routeSlice(catalog, "router.get('/catalog'");
        expect(missingFrom(slice, [
            'apps', 'datatables', 'knowledgeBases', 'agents', 'formPickSources', 'agentsError',
            'knowledgeWriteStrategies', 'datatableOps', 'steps', 'triggerOutputs', 'triggerMeta',
            'deliverability', 'stepTypes', 'triggers', 'flags',
            // the flags
            'code', 'codeReason', 'automations',
        ])).toEqual([]);
        // One app and one action are built in catalogApps.js.
        expect(missingFrom(functionSlice(read('routes/automation/catalogApps.js'), 'buildApps'), [
            'name', 'label', 'description', 'inputSchema', 'outputSchema', 'outputSample', 'producesList',
            'listField', 'sideEffect', 'effect', 'integrationId', 'integrationLabel', 'available', 'actions',
        ])).toEqual([]);
        expect(missingFrom(functionSlice(read('automation/formPickSources.js'), 'catalog'), [
            'id', 'appId', 'app', 'label', 'searchHint', 'internal', 'sampleData',
        ])).toEqual([]);
        // Registered inside a function, so the handler is indented; routeSlice
        // ends it where it closes, before the skill preview.
        const agentPreview = routeSlice(agentSteps, "router.get('/catalog/agent/:agentId'");
        expect(agentPreview).not.toContain("router.get('/catalog/skill/:skillId'");
        expect(missingFrom(agentPreview, [
            'id', 'canUse', 'name', 'runtimeSource', 'permissions', 'allowed', 'withheld', 'degraded', 'error',
        ])).toEqual([]);
    });

    it('the version, webhook, form-link, folder, template and usage rows still carry their fields', () => {
        const versionStore = read('stores/automationStore/versions.js');
        expect(missingFrom(functionSlice(versionStore, 'listVersions'), [
            'id', 'automationId', 'version', 'savedByUserId', 'savedAt', 'changeSummary', 'savedByName',
        ])).toEqual([]);
        expect(missingFrom(functionSlice(versionStore, 'getVersion'), ['id', 'automationId', 'version', 'definition', 'savedByUserId', 'savedAt'])).toEqual([]);

        const webhooks = read('stores/automationStore/webhooks.js');
        expect(missingFrom(functionSlice(webhooks, 'getWebhooksForAutomation'), [
            'id', 'automationId', 'allowMethods', 'lastSeenAt', 'createdAt', 'triggerStepId',
        ])).toEqual([]);
        expect(missingFrom(functionSlice(webhooks, 'createWebhook'), ['id', 'automationId', 'secret', 'triggerStepId'])).toEqual([]);
        expect(missingFrom(functionSlice(webhooks, 'rotateWebhookSecret'), ['id', 'automationId', 'secret'])).toEqual([]);
        expect(routeSlice(links, "router.post('/:id/webhook'")).toContain('url: webhookUrlForSlug(wh.id, req)');

        expect(missingFrom(functionSlice(read('stores/automationStore/forms.js'), 'rowToPage'), [
            'id', 'automationId', 'triggerStepId', 'createdAt', 'lastSeenAt', 'submissions', 'audience', 'sharedGroups', 'sharedUserIds',
        ])).toEqual([]);
        expect(missingFrom(functionSlice(read('stores/automationStore/folders.js'), 'rowToFolder'), [
            'id', 'organizationId', 'name', 'icon', 'color', 'createdAt', 'updatedAt', 'automationCount',
        ])).toEqual([]);

        const templates = read('automation/templates.js');
        expect(missingFrom(functionSlice(templates, 'listTemplates'), ['id', 'title', 'description', 'category', 'icon', 'tags'])).toEqual([]);
        expect(functionSlice(templates, 'deriveTemplateMeta')).toContain('return { requiredIntegrations: [...integrations], triggerReadiness,');
        // The gallery is the organisation's saved templates, then the built-in ones.
        const gallery = routeSlice(importExport, "router.get('/templates'");
        expect(gallery).toContain('await listTemplatesFor(');
        expect(gallery).toContain('res.json({ templates, categories: CATEGORIES })');
        expect(functionSlice(templates, 'listTemplatesFor')).toContain('return [...cards, ...listTemplates()]');
        expect(missingFrom(functionSlice(templates, 'orgTemplateCard'), ['id', 'title', 'description', 'category', 'icon', 'tags'])).toEqual([]);

        expect(missingFrom(functionSlice(read('stores/automationUsageStore.js'), 'mapRow'), [
            'automationId', 'consumerKind', 'consumerId', 'consumerTitle', 'refId', 'actionId', 'screenId', 'nodeId', 'label', 'wired', 'updatedAt',
        ])).toEqual([]);
        const usage = routeSlice(crud, "router.get('/:id/usage'");
        expect(missingFrom(usage, ['usage', 'canOpen', 'complete'])).toEqual([]);
        // A failed read is an ERROR, never `{ usage: [] }` (lifecycle.ts relies on it).
        expect(usage).toContain("throw new HttpError(500, 'usage_unavailable', 'usage_unavailable')");
    });

    it('the builder turn still reads every key the phone sends, and the session still carries what it reads', () => {
        // builderTurnBody in src/features/flow-editor/api/builder.ts.
        expect(chatStream).toContain("const { TurnBody, TurnQuery, setupTurn } = require('./turnSetup');");
        expect(missingFrom(declSlice(turnSetup, 'TurnBody'), [
            'message', 'builderSessionId', 'automationId', 'modelTier', 'history', 'attachments',
            'webSearchEnabled', 'disabledMedia', 'timezone', 'canvasScope', 'seedMetadata',
        ])).toEqual([]);
        const persisted = turnClosing.slice(turnClosing.indexOf('automationStore.setBuilderSession('));
        expect(missingFrom(persisted.slice(0, 1200), [
            'sessionId', 'draft', 'lastValidation', 'summary', 'conversation', 'todos', 'updatedAt',
        ])).toEqual([]);
    });
});

describe('App Studio (server/routes/studioApps*.js, studioAppData.js, the builder)', () => {
    // Mirrored by src/features/app-studio/model/{apiTypes,runtimeTypes,
    // builderTypes}.ts and read through api/readers*.ts. The builder's SSE
    // event names are held separately, both ways, by readersBuilder.test.ts.
    // routes/studioApps.js mounts one sub-router per file in routes/studioApps/;
    // a slice is cut from the one file that holds its marker.
    const APP_ROUTERS = ['templates', 'crud', 'appImport', 'publish', 'publicPages', 'runtime'];
    const apps = APP_ROUTERS.map((name) => read(`routes/studioApps/${name}.js`));
    const run = read('routes/studioAppsRun.js');
    const data = read('routes/studioAppData.js');
    // studioAppData.js keeps the route table; its handlers live in routes/studio/appData*.js.
    const dataHandlers = readSplit(
        'routes/studio/appDataContext.js', 'routes/studio/appDataRecords.js',
        'routes/studio/appDataQuery.js', 'routes/studio/appDataAdmin.js',
    );
    // studioAppStore.js is the barrel; the row mappers are in studioApp/rowMappers.js.
    const store = read('stores/studioApp/rowMappers.js');

    it('still mounts the studio routers and the builder', () => {
        const index = read('index.js');
        expect(index).toContain("'/api/studio-apps'");
        expect(index).toContain("'/api/studio-apps/builder'");
        const barrel = read('routes/studioApps.js');
        for (const name of APP_ROUTERS) expect(barrel).toContain(`router.use('/', require('./studioApps/${name}'));`);
    });

    it('mapAppMetaRow still maps every field an app row carries', () => {
        expect(
            missingFrom(functionSlice(store, 'mapAppMetaRow'), [
                'id', 'userId', 'organizationId', 'projectId', 'name', 'description', 'icon',
                'accentColor', 'category', 'definitionVersion', 'publishedVersion', 'isPublished',
                'sharedGroups', 'templateId', 'templateVersion', 'nextcloudMenu',
                'publishedAt', 'createdAt', 'updatedAt',
            ]),
        ).toEqual([]);
        expect(missingFrom(functionSlice(store, 'mapAppRow'), ['definition', 'publishedDefinition'])).toEqual([]);
        expect(missingFrom(functionSlice(store, 'mapVersionMetaRow'), ['id', 'appId', 'summary', 'createdAt'])).toEqual([]);
    });

    it('still answers the list, detail and gallery routes in the read shape', () => {
        expect(missingFrom(routeSlice(apps, "router.get('/mine'"), ['usage', 'dbBytes', 'dbRatio', 'apps'])).toEqual([]);
        expect(missingFrom(routeSlice(apps, "router.get('/:id',"), ['app', 'readOnly'])).toEqual([]);
        expect(missingFrom(routeSlice(apps, "router.get('/templates',"), ['templates'])).toEqual([]);
        expect(missingFrom(routeSlice(apps, "router.post('/',"), ['app', 'dataInstall'])).toEqual([]);
        expect(missingFrom(routeSlice(apps, "router.post('/import'"), ['app', 'report', 'warnings'])).toEqual([]);
    });

    it('still answers the CAS save with the keys the autosave reconciles from', () => {
        const save = routeSlice(apps, "router.put('/:id/definition'");
        expect(save).toContain('definition, baseVersion');
        expect(save).toContain('status(409)');
        expect(save).toContain('status(422)');
        expect(missingFrom(save, ['currentVersion', 'definition', 'version', 'warnings', 'repairs', 'errors'])).toEqual([]);
    });

    it('still reads and answers publish, check and public pages as the phone sends them', () => {
        const publish = routeSlice(apps, "router.patch('/:id/publish'");
        expect(publish).toContain('isPublished, sharedGroups');
        expect(missingFrom(publish, ['isPublished', 'sharedGroups', 'publishedVersion', 'errors', 'warnings'])).toEqual([]);
        expect(routeSlice(apps, "router.post('/:id/check'")).toContain('screenId, asRole');
        expect(missingFrom(functionSlice(apps, 'publicPageView'), ['token', 'url', 'createdAt', 'lastSeenAt', 'visits'])).toEqual([]);
        expect(missingFrom(routeSlice(apps, "router.get('/:id/public-pages'"), ['pages', 'publicAccess', 'blockers'])).toEqual([]);
        expect(missingFrom(routeSlice(apps, "router.get('/:id/versions'"), ['versions'])).toEqual([]);
    });

    it('still answers the runtime payload with the run view keys', () => {
        expect(
            missingFrom(routeSlice(apps, "router.get('/:id/runtime'"), [
                'id', 'name', 'icon', 'accentColor', 'definition', 'viewer', 'draft', 'appVersion',
            ]),
        ).toEqual([]);
        expect(missingFrom(functionSlice(apps, 'buildRuntimeViewer'), ['id', 'name', 'email', 'isOwner', 'roleKey'])).toEqual([]);
    });

    it('still answers an action run, a poll and a step in the read shape', () => {
        expect(missingFrom(functionSlice(run, 'runBody'), ['runId', 'status', 'output', '_appEffects', '_appEffectsUnknown', 'error'])).toEqual([]);
        const step = routeSlice(run, "router.post('/:id/actions/:actionId/step'");
        expect(missingFrom(step, ['ok', 'result', 'error', 'code', 'limit', 'used'])).toEqual([]);
        expect(step).toContain('req.body?.stepIndex');
        expect(routeSlice(run, "router.post('/:id/actions/:actionId/run'")).toContain('req.body?.wait');
        // A draft runtime's buttons run the draft: runAppAction sends `?draft=1`.
        expect(routeSlice(run, "router.post('/:id/actions/:actionId/run'")).toContain('req.query?.draft');
    });

    it('still answers the data routes in the read shape', () => {
        expect(missingFrom(functionSlice(dataHandlers, 'publicTable'), [
            'id', 'key', 'name', 'icon', 'fields', 'type', 'subtype', 'required', 'unique', 'options', 'relation',
        ])).toEqual([]);
        expect(missingFrom(routeHandlerSlice(data, "router.get('/:id/data/tables/:tableId/records'", dataHandlers), ['records', 'nextCursor', 'appVersion'])).toEqual([]);
        expect(missingFrom(routeHandlerSlice(data, "router.post('/:id/data/batch'", dataHandlers), ['results', 'appVersion'])).toEqual([]);
        const patch = routeHandlerSlice(data, "router.patch('/:id/data/tables/:tableId/records/:recordId'", dataHandlers);
        expect(patch).toContain('expectedUpdatedAt');
        expect(patch).toContain("code: 'record_conflict'");
        expect(missingFrom(routeHandlerSlice(data, "router.get('/:id/schema'", dataHandlers), ['model', 'modelVersion'])).toEqual([]);
        const schema = routeHandlerSlice(data, "router.put('/:id/schema'", dataHandlers);
        expect(schema).toContain('body.expectedVersion');
        expect(missingFrom(schema, ['currentVersion', 'model', 'version', 'errors'])).toEqual([]);
    });

    it('still persists the builder snapshot keys the session reader reads', () => {
        expect(read('routes/ai/appStudioBuilder/sessionSnapshot.js')).toContain('res.json({ snapshot })');
        const persist = functionSlice(read('routes/ai/appStudioBuilder/turnClosing.js'), 'persistTurnSnapshot');
        expect(missingFrom(persist, ['sessionId', 'appId', 'messages', 'lastValidation', 'summary', 'updatedAt', 'lastTier', 'todos', 'brief'])).toEqual([]);
        expect(absentTokens(persist, ['approvedPlan', 'pendingPlan', 'continueToken'])).toEqual([]);
    });
});

describe('the webpage builder (features/webpages)', () => {
    // The builder screens read more than the publishing ones: the page's
    // brief, knowledge bases and settings; its sources and versions; who can
    // see it. Each list below is what a reader in features/webpages/api reads.

    it('mapWebpageRow still maps what the builder tabs read', () => {
        expect(
            missingFrom(functionSlice(read('stores/webpage/shared.js'), 'mapWebpageRow'), [
                'instructions', 'knowledgeBaseIds', 'settings', 'slug', 'publicShareCount',
            ]),
        ).toEqual([]);
    });

    it('mapSourceRow still maps every field the Knowledge tab renders', () => {
        expect(
            missingFrom(functionSlice(read('stores/webpage/sources.js'), 'mapSourceRow'), [
                'id', 'type', 'name', 'storageKey', 'metadata', 'status', 'error', 'wordCount', 'createdAt',
            ]),
        ).toEqual([]);
    });

    it('the version list still carries what the History tab renders', () => {
        const versions = read('stores/webpage/versions.js');
        expect(
            missingFrom(functionSlice(versions, 'getVersions'), ['id', 'summary', 'contentLength', 'createdAt', 'source']),
        ).toEqual([]);
        expect(missingFrom(functionSlice(versions, 'mapVersionFacts'), ['seq', 'lineDelta'])).toEqual([]);
        const listing = read('routes/webpages/versionListing.js');
        expect(missingFrom(functionSlice(listing, 'decorateVersionRow'), ['actor', 'isPublished'])).toEqual([]);
        expect(missingFrom(functionSlice(listing, 'versionCoverage'), ['coversProject'])).toEqual([]);
        expect(read('routes/webpages/versions.js')).toContain('hasMore');
    });

    it('the audience model still carries what the Share tab renders', () => {
        const model = functionSlice(read('core/webpages/webpagePublicAudience.js'), 'buildAudienceModel');
        expect(
            missingFrom(model, [
                'internal', 'public', 'address', 'columnGate', 'shareCount', 'shareCountKnown',
                'on', 'known', 'accessMode', 'hasPassword', 'allowedEmails', 'expiresAt', 'viewCount', 'slug', 'url',
            ]),
        ).toEqual([]);
    });

    it('the grants and data cards still carry what the Data tab renders', () => {
        expect(
            missingFrom(functionSlice(read('integrations/webpageGrants.js'), 'describeGrants'), [
                'tool', 'label', 'integrationLabel', 'available', 'automationId', 'discoveryFailed',
            ]),
        ).toEqual([]);
        expect(
            missingFrom(functionSlice(read('core/webpages/webpageDataCards.js'), 'buildDataCards'), [
                'datatableId', 'missing', 'name', 'rowCount', 'usedInCode', 'publicColumns', 'tables', 'automations',
            ]),
        ).toEqual([]);
    });

    it('every event the builder stream sends is routed or ignored on purpose', () => {
        // webpageChat.js writes through its own `send('x', …)` helper, which
        // the scan above (onEvent/sendEvent) does not see.
        // webpageChat.js and the parts in routes/ai/webpageChat/.
        const source = read('routes/ai/webpageChat.js') + readTree('routes/ai/webpageChat');
        const sent = [...new Set([...source.matchAll(/\bsend\(\s*'([a-z_]+)'/g)].map((m) => m[1] as string))];
        expect(sent.length).toBeGreaterThan(10);
        expect(sent.filter((e) => !accounts(WEBPAGE_FRAMES, e))).toEqual([]);
        // phaseEvents.js emits the stage frames through the same helper.
        expect(read('core/agentRuntime/phaseEvents.js')).toContain("send('phase'");
    });
});

describe('datatables (server/routes/datatables/**)', () => {
    // Mirrored by the readers in src/features/datatables/api/readers.ts.
    it('publicTable still projects every field the phone reads', () => {
        const slice = functionSlice(read('routes/datatables/projection.js'), 'publicTable');
        expect(
            missingFrom(slice, [
                'id', 'name', 'key', 'description', 'rowCount', 'rowScope', 'isPublished',
                'sharedGroups', 'writeMode', 'retentionDays', 'managedKind', 'source',
                'ownerUserId', 'updatedAt', 'scopeKind', 'grade',
            ]),
        ).toEqual([]);
    });

    it('the list still answers {datatables, scope} with a usageCount per table', () => {
        const slice = routeSlice(read('routes/datatables/tables.js'), "router.get('/'");
        expect(missingFrom(slice, ['datatables', 'scope', 'usageCount'])).toEqual([]);
    });

    it('a row page still carries its keyset cursor and the total', () => {
        const slice = routeHandlerSlice(read('routes/datatables/rows.js'), "router.get('/:id/rows'", [read('routes/datatables/rowHandlers.js')]);
        expect(missingFrom(slice, ['rows', 'hasMore', 'nextCursor', 'total'])).toEqual([]);
    });

    it('a grant is still snake_case on the wire', () => {
        const slice = functionSlice(read('stores/datatableStore/rowMappers.js'), 'rowToGrant');
        expect(missingFrom(slice, ['id', 'grantee_type', 'grantee_id', 'grade'])).toEqual([]);
    });

    it('the usage index still names its consumer, owner, step and mode', () => {
        const slice = functionSlice(read('stores/datatableStore/usage.js'), 'listUsage');
        expect(
            missingFrom(slice, [
                'consumerKind', 'consumerId', 'consumerTitle', 'consumerOwner',
                'stepOrdinal', 'stepOp', 'mode', 'columns', 'lastRunAt',
            ]),
        ).toEqual([]);
    });

    it('still lives at /api/datatables, with the delete confirmation on the query string', () => {
        expect(read('index.js')).toContain("app.use('/api/datatables'");
        expect(read('routes/datatables/deleteTable.js')).toContain('query: ConfirmBreakingQuery');
    });
});

describe('Meeting Notes tools (routes/transcriptions/*, routes/summaryTemplates.js)', () => {
    // Read by features/recording (tags, report), features/meetingTemplates,
    // features/meetingSources and features/meetingRules. Their readers name
    // the handler each shape comes from; these pin the keys those readers use.
    it('GET /tags answers { tag, count } rows', () => {
        expect(read('routes/transcriptions/tags.js')).toMatch(/tag: String\(r\.tag\), count: Number\(r\.count\)/);
    });

    it('POST /report answers the report, its source and the truncation count', () => {
        const slice = routeSlice(read('routes/transcriptions/report.js'), "router.post('/report',");
        expect(absentTokens(slice, ['report', 'usedTranscripts', 'truncatedNotes'])).toEqual([]);
        expect(read('routes/transcriptions/report.js')).toMatch(/ids: idList\(/);
    });

    it('PATCH /:id still takes tags', () => {
        const source = read('routes/transcriptions/noteActions.js');
        expect(source).toMatch(/tags: z\.array\(/);
        expect(routeSlice(source, "router.patch('/:id',")).toContain('updates.tags');
    });

    it('the summary-template routes keep their list, body and row keys', () => {
        const source = read('routes/summaryTemplates.js');
        expect(
            absentTokens(routeSlice(source, "router.get('/',"), ['builtins', 'custom', 'defaultTemplateId', 'canManageOrg']),
        ).toEqual([]);
        expect(absentTokens(source, ['scope', 'groupId', 'isDefault', 'groups'])).toEqual([]);
        expect(
            missingFrom(functionSlice(read('stores/summaryTemplateStore.js'), 'mapRow'), [
                'id', 'scope', 'name', 'prompt', 'groupId', 'isDefault',
            ]),
        ).toEqual([]);
    });

    it('the meeting-source routes keep the keys the phone reads', () => {
        expect(
            absentTokens(read('routes/transcriptions/nextcloud.js'), [
                'recordingEnabled', 'recordingMode', 'postSummaryBack', 'recordedNoteId', 'recordDecided',
                'recordReason', 'isModerator', 'effectiveRecord', 'overridden', 'nextcloud_path', 'rooms', 'items',
            ]),
        ).toEqual([]);
        expect(
            absentTokens(read('routes/transcriptions/gmeet.js'), [
                'autoImport', 'autoRecordConfig', 'importedNoteId', 'recordingControlledByHost', 'recordingState',
                'transcriptionId', 'jobId', 'event_id', 'meeting_code', 'effectiveRecord', 'overridden',
            ]),
        ).toEqual([]);
    });

    it('the automation list and facets keep the keys the rules screen reads', () => {
        expect(read('routes/automation/crud.js')).toContain('res.json({ automations })');
        expect(read('routes/automation/runs.js')).toContain('res.json({ facets, rangeHours: range })');
    });
});

describe('studio documents payloads (server/stores/documentStore.js, routes/studioDocuments.js)', () => {
    // Mirrored by StudioDocumentRow / StudioDocument / DocumentVersion in
    // src/features/studioDocuments/model/types.ts; read by api/readers.ts.
    // The row mappers moved out of documentStore.js into their own module
    // (stores/document/rowMappers.js); documentStore requires them from there.
    const store = read('stores/document/rowMappers.js');
    const routes = read('routes/studioDocuments.js');
    // The history moved to the uniform version API: its router is mounted at
    // /:id/versions (routes/studioDocuments/versions.js) and its rows are
    // mapped by stores/documentVersions.js. The paths the phone calls did not
    // change: GET /:id/versions answers { versions }, and a restore still
    // takes expectedVersionId.
    const versionRoutes = read('routes/studioDocuments/versions.js');
    const versionRows = read('stores/documentVersions.js');

    it('mapListRow still maps every field the library renders', () => {
        expect(
            missingFrom(functionSlice(store, 'mapListRow'), [
                'id', 'name', 'docType', 'description', 'kind', 'visibility', 'categories', 'versionId', 'htmlSize', 'updatedAt',
            ]),
        ).toEqual([]);
    });

    it('mapRow still maps the slots and settings the editor reads and writes back', () => {
        expect(
            missingFrom(functionSlice(store, 'mapRow'), ['id', 'name', 'docType', 'bodyHtml', 'css', 'settings', 'kind', 'visibility', 'versionId']),
        ).toEqual([]);
    });

    it('listVersions still answers id, summary and createdAt', () => {
        expect(missingFrom(functionSlice(versionRows, 'mapVersion'), ['id', 'summary', 'createdAt'])).toEqual([]);
        expect(functionSlice(versionRows, 'listRows')).toContain('versions: page.map(mapVersion)');
    });

    it('still serves every route the phone calls, with the envelopes it reads', () => {
        for (const route of [
            "router.get('/'", "router.post('/'", "router.get('/:id'", "router.patch('/:id'", "router.delete('/:id'",
            "router.get('/starters'", "router.post('/:id/duplicate'", "router.post('/:id/validate'", "router.get('/:id/pdf'",
            "router.get('/:id/pptx'", "router.get('/:id/preview'", "router.use('/:id/versions', require('./studioDocuments/versions'))",
        ]) {
            expect([route, routes.includes(route)]).toEqual([route, true]);
        }
        for (const route of ["router.get('/'", "router.post('/:ref/restore'"]) {
            expect([route, versionRoutes.includes(route)]).toEqual([route, true]);
        }
        expect(absentTokens(routes, ['documents', 'document', 'starters', 'editable', 'contract'])).toEqual([]);
        expect(absentTokens(versionRoutes, ['versions', 'expectedVersionId'])).toEqual([]);
    });
});

describe('the Solution payloads (routes/projects.js, projects/summary.js, routes/projects/packaging.js)', () => {
    // Read by src/features/projects/api/*Readers.ts, which keep every `null`
    // these routes send for "could not be read" apart from a 0 or `[]`.
    it('the overview row still carries every field a card reads', () => {
        expect(
            missingFrom(read('projects/summary.js'), [
                'id', 'name', 'description', 'icon', 'permission', 'installedFromBlueprintId',
                'counts', 'runs', 'completeness', 'update', 'blocked', 'complete', 'errors', 'warnings',
                'installedVersion', 'latestVersion', 'available', 'projects', 'unavailable',
            ]),
        ).toEqual([]);
    });

    it('the activity page, the checks, installs and publishing keep their shapes', () => {
        const routes = read('routes/projects.js');
        // One page, then file rows named while the file is still in the project
        // (projects/projectFiles.nameFileActivity); the envelope is unchanged.
        expect(functionSlice(read('stores/project/events.js'), 'listActivity')).toContain('rows.map(mapActivityRow)');
        // The feed and the checks are sub-routers routes/projects.js mounts.
        expect(routes).toContain("router.use('/', require('./projects/activity').makeActivityRouter({");
        expect(routes).toContain("router.use('/', require('./projects/resources').makeResourcesRouter({");
        const activity = routeSlice(read('routes/projects/activity.js'), "router.get('/:id/activity'");
        expect(activity).toContain('const page = hasMore ? items.slice(0, limit) : items;');
        expect(activity).toContain('res.json({ items: named, hasMore })');
        expect(
            // listActivity maps each row with the change feed's mapper.
            missingFrom(functionSlice(read('stores/projectChanges.js'), 'mapActivityRow'), [
                'id', 'actorId', 'action', 'targetType', 'targetId', 'details', 'createdAt',
            ]),
        ).toEqual([]);
        expect(routeSlice(read('routes/projects/resources.js'), "router.get('/:id/completeness'")).toContain('blocked: true');
        expect(read('projects/completeness.js')).toContain('deepLink');
        const packaging = read('routes/projects/packaging.js');
        expect(routeSlice(packaging, "router.get('/:id/package/installs'")).toContain('installsHere');
        expect(routeSlice(packaging, "router.post('/package/install'")).toContain('res.json({ projectId: result.projectId, report: result.report })');
        expect(packaging).toContain('_savedAs: saved.id, _version: saved.version');
    });
});

describe('the run log (server/stores/automationStore/runs.js + routes/automation/runs.js)', () => {
    // Mirrored by LogRun / RunFacets in src/features/runs/model/types.ts and
    // read by src/features/runs/api/readers.ts. The org row is an ALLOW-LIST
    // (rowToOrgRunRow), so a field dropped there is gone from the org scope
    // without a word — which is what this pin is for.
    const store = read('stores/automationStore/runs.js');
    // rowToOrgRunRow hands the mapped row to projectOrgRun, split out of runs.js.
    const orgRunRow = read('stores/automationStore/orgRunRow.js');
    const routes = read('routes/automation/runs.js');

    it('rowToOrgRunRow still carries every field the log row reads, and `mine`', () => {
        expect(functionSlice(store, 'rowToOrgRunRow')).toContain('projectOrgRun(rowToRunWithAutomation(r), viewerUserId)');
        expect(
            missingFrom(functionSlice(orgRunRow, 'projectOrgRun'), [
                'id', 'journeyRunId', 'automationId', 'automationTitle', 'automationKind',
                'rootStepId', 'rootTriggerLabel', 'triggerKind', 'mode', 'status',
                'startedAt', 'finishedAt', 'durationMs', 'summary', 'error', 'errorClass',
                'handledErrorCount', 'mine',
            ]),
        ).toEqual([]);
    });

    it('rowToRunWithAutomation still adds the automation fields to my runs', () => {
        expect(
            missingFrom(functionSlice(store, 'rowToRunWithAutomation'), [
                'automationTitle', 'automationKind', 'rootTriggerLabel', 'journeyRunId',
            ]),
        ).toEqual([]);
    });

    it('the facets still hold the chip maps and the per-automation rollup', () => {
        const facets = functionSlice(store, 'getRunFacetsScoped');
        expect(absentTokens(facets, [
            'status', 'triggerKind', 'automationId', 'errorClass', 'automations', 'automationsTotal',
            'title', 'kind', 'total', 'lastRunAt', 'lastErrorAt', 'lastErrorClass',
        ])).toEqual([]);
    });

    it('still serves both scopes on their own routes, and the stream', () => {
        for (const marker of [
            "router.get('/_runs/recent'",
            "router.get('/_runs/facets'",
            "router.get('/_runs/org'",
            "router.get('/_runs/org/facets'",
            "router.get('/_runs/stream'",
        ]) {
            expect(routes).toContain(marker);
        }
        expect(absentTokens(routeSlice(routes, "router.get('/_runs/org'"), ['runs', 'nextCursor'])).toEqual([]);
    });
});

describe('playbooks (server/stores/playbookStore.js + routes/playbooks/)', () => {
    // Mirrored by Playbook / PlaybookSummary in src/features/playbooks/model/types.ts
    // and read by src/features/playbooks/api/readers.ts.
    const store = read('stores/playbookStore.js');
    const phaseList = read('routes/playbooks/phaseList.js');
    const routes = readTree('routes/playbooks');

    it('mapRow still maps every field the run screen reads, the version above all', () => {
        expect(
            missingFrom(functionSlice(store, 'mapRow'), [
                'id', 'recipeId', 'title', 'status', 'options', 'phases', 'currentPhase', 'version', 'createdAt', 'updatedAt',
            ]),
        ).toEqual([]);
    });

    it('summarise still builds the list row', () => {
        expect(
            missingFrom(functionSlice(phaseList, 'summarise'), [
                'id', 'title', 'recipeLabel', 'status', 'currentPhase', 'progress', 'done', 'total', 'locked', 'phases', 'kind', 'label', 'updatedAt',
            ]),
        ).toEqual([]);
    });

    it('still serves every route the phone calls', () => {
        for (const marker of [
            "router.get('/'",
            "router.post('/'",
            "router.get('/:id'",
            "router.patch('/:id'",
            "router.delete('/:id'",
            "router.post('/recipes/compose'",
            "router.post('/:id/phases/:key/run'",
            "router.post('/:id/phases/:key/skip'",
            "router.post('/:id/phases/:key/retry'",
            "router.post('/:id/phases/:key/access-plan'",
            "router.post('/:id/phases/:key/register'",
        ]) {
            expect(routes).toContain(marker);
        }
        expect(read('index.js')).toContain("'/api/playbooks'");
    });

    it('still answers a conflict with the current playbook, which the phone adopts', () => {
        expect(routes).toContain("'version_conflict', 'This playbook changed elsewhere.', { currentVersion");
        expect(absentTokens(routes, ['expectedVersion', 'resetBrief', 'feedback', 'recheck', 'registration', 'risks', 'written', 'failed'])).toEqual([]);
    });
});

describe('skill structure, tests and drafts (server/stores/skillStore.js, routes/skills/*)', () => {
    // The Studio editor on the phone (src/features/skills) edits a skill the
    // way the web does: it reads and PUTs the structured facets and reads the
    // side routes below. A rename on either side leaves an empty editor or a
    // PUT the server re-parses — both silent.
    it('mapRow still maps every structured facet the editor reads', () => {
        const source = read('stores/skill/rows.js');
        expect(
            missingFrom(functionSlice(source, 'mapRow'), [
                'steps', 'rulesV2', 'examplesV2', 'outputSchema', 'knowledgeBaseIds', 'allowedAutomationIds', 'lastUsedAt',
            ]),
        ).toEqual([]);
    });

    it('PUT still accepts the structured facets it saves', () => {
        const routes = read('routes/skills.js');
        for (const key of ['steps:', 'rulesV2:', 'examplesV2:', 'outputSchema:', 'knowledgeBaseIds:', 'allowedAutomationIds:', 'sharedGroups:']) {
            expect(routes).toContain(key);
        }
    });

    it('the test stream still sends the four frames the Test tab reads', () => {
        const source = read('routes/skills/test.js');
        for (const frame of ["send('answer'", "send('done'", "send('error'", "send('notice'"]) expect(source).toContain(frame);
        expect(source).toContain("code: 'kb_dropped'");
    });

    it('the draft route still takes a sentence and answers { draft }, improve { skill }', () => {
        const ai = read('routes/skills/ai.js');
        expect(ai).toContain('sentence');
        expect(ai).toContain('res.json({ draft: parsed })');
        expect(ai).toContain('res.json({ skill:');
    });
});

describe('knowledge base Studio routes (server/routes/knowledgeBases/*)', () => {
    // src/features/knowledge reads these for its Sources, Settings, Test
    // question and Used-by tabs; a rename here empties a tab silently.
    it('mapSourceForApi still sends every field the Sources tab reads', () => {
        const source = read('routes/knowledgeBases/sources.js');
        expect(
            missingFrom(functionSlice(read('routes/knowledgeBases/sourcePolicy.js'), 'mapSourceForApi'), [
                'id', 'kind', 'name', 'config', 'refreshMode', 'refreshCron', 'refreshTz', 'supportsModes',
                'nextRefreshAt', 'lastRefreshAt', 'status', 'error', 'documentCount', 'processedCount',
                'errorCount', 'skippedCount', 'redactedCount', 'piiFoundCount', 'createdBy',
            ]),
        ).toEqual([]);
        expect(source).toContain('res.json({ sources: items, totals })');
    });

    it('a source’s documents keep the projected columns and filters the source sheet reads', () => {
        const source = read('routes/knowledgeBases/sources.js');
        expect(source).toContain("router.get('/:id/sources/:sid/documents'");
        expect(source).toContain('res.json({ documents, total, limit, offset })');
        // knowledgeBases.js re-exports DOCUMENT_COLUMNS from kb/model.js.
        expect(read('stores/knowledgeBases.js')).toContain("DOCUMENT_COLUMNS } = require('./kb/model');");
        const columns = read('stores/kb/model.js').match(/const DOCUMENT_COLUMNS = \[([^\]]+)\]/)?.[1] ?? '';
        for (const col of ['status', 'status_reason', 'pii_status', 'title', 'source_uri', 'created_at']) expect(columns).toContain(`'${col}'`);
        const filters = read('routes/knowledgeBases/docFilters.js');
        for (const token of ['statusFilter', 'piiFilter', "'found'"]) expect(filters).toContain(token);
    });

    it('the ask stream still sends the passages first, then text and done', () => {
        const source = read('routes/knowledgeBases/ask.js');
        for (const frame of ["send('kb_sources'", "send('text'", "send('done'", "send('error'"]) expect(source).toContain(frame);
    });

    it('settings, audience, usage and bulk delete keep their shapes', () => {
        const detail = read('routes/knowledgeBases/detail.js');
        for (const key of ['categoryId:', 'usageContexts:', 'organizationId:', 'isPublished:', 'sharedGroups:']) expect(detail).toContain(key);
        expect(read('routes/knowledgeBases/usage.js')).toContain('unchecked: partial');
        expect(read('routes/knowledgeBases/documents.js')).toContain('documentIds');
        expect(read('routes/knowledgeBases/system.js')).toContain('res.json({ items: payload, orgId, isSuperAdmin })');
    });
});

describe('the subscription and Stripe payloads (routes/subscriptions/*, routes/stripe/*)', () => {
    // Read by features/billing (api/readers.ts). The subscription GET is the
    // one License & Usage renders whole; the lifecycle writes answer a raw
    // row, so the phone re-reads this GET after each of them.
    it('the org subscription GET still answers every key the screen reads', () => {
        const slice = routeSlice(read('routes/subscriptions/orgSubscriptions.js'), "router.get('/orgs/:orgId',");
        expect(
            absentTokens(slice, [
                'effective_limits', 'billing', 'current_usage', 'changeable_plans', 'pending_plan_name',
                'plan_price', 'plan_currency', 'seat_quantity', 'subscription_total', 'usage_pooled',
                'per_user_cap', 'has_stripe_price', 'direction',
            ]),
        ).toEqual([]);
    });

    it('the lifecycle routes keep their paths and their bodies', () => {
        const source = read('routes/subscriptions/lifecycle.js');
        for (const route of ['upgrade', 'preview-change', 'cancel-downgrade', 'cancel', 'reactivate']) {
            expect(source).toContain(`router.post('/orgs/:orgId/${route}'`);
        }
        expect(source).toContain("router.post('/orgs/:orgId/upgrade', validate({ body: PlanChangeBody })");
        expect(source).toContain("router.post('/orgs/:orgId/cancel', validate({ body: NoBody })");
        expect(
            absentTokens(routeSlice(source, "router.post('/orgs/:orgId/preview-change',"), [
                'direction', 'currency', 'per_seat', 'seat_quantity', 'next_renewal_total', 'proration_amount', 'effective',
            ]),
        ).toEqual([]);
    });

    it('Checkout, its reconcile, the portal, plans and invoices keep their shapes', () => {
        const checkout = read('routes/stripe/checkout.js');
        expect(checkout).toContain("router.post('/checkout',");
        expect(absentTokens(checkout, ['planId', 'origin', 'sessionId', 'subscription_status'])).toEqual([]);
        expect(checkout).toContain("router.get('/sessions/:id',");
        const portal = read('routes/stripe/portal.js');
        expect(portal).toContain("router.post('/portal',");
        expect(absentTokens(portal, ['origin', 'url'])).toEqual([]);
        const plans = read('routes/stripe/plans.js');
        expect(plans).toContain("router.get('/plans',");
        expect(absentTokens(routeSlice(plans, "router.get('/status',"), ['enabled', 'testMode'])).toEqual([]);
        const invoices = read('routes/stripe/invoices.js');
        expect(invoices).toContain("router.get('/invoices/:id/pdf',");
        expect(routeSlice(invoices, "router.get('/invoices',")).toContain('invoices');
        // The rows are shaped by the Stripe service the route calls.
        expect(
            // stripeService.js is the barrel; invoices are shaped in stripe/invoicesPromos.js.
            absentTokens(read('services/stripe/invoicesPromos.js'), ['number', 'created', 'amountPaid', 'amountDue', 'currency', 'status', 'invoicePdf']),
        ).toEqual([]);
    });
});

describe('the organisation integrations (features/orgIntegrations)', () => {
    // Each api/*.ts header names the route it was verified against; these pin
    // the paths and the keys its readers take, per server file.
    it('the Maps key, the Nextcloud switches and the beta switches keep their keys', () => {
        const instance = read('routes/ai/config/instanceConfig.js');
        expect(absentTokens(instance, ['hasGoogleMapsKey', 'googleMapsApiKey'])).toEqual([]);
        const nc = read('routes/admin/ncIntegrations.js');
        expect(nc).toContain('/nc-integrations/groups/:groupId');
        expect(absentTokens(nc, ['enabled', 'usingDefaults', 'groups', 'disabledIntegrations', 'userCount'])).toEqual([]);
        expect(
            absentTokens(read('auth/admin/featureAccessRoutes.js'), [
                'enabledBetaFeatures', 'allowedBetaFeatures', 'betaGoverned', 'betaEnabled', 'assignments', 'features',
            ]),
        ).toEqual([]);
    });

    it('the n8n routes keep their paths and the keys the three tabs read', () => {
        const source = read('routes/ai/config/integrations.js');
        for (const marker of [
            "router.get('/n8n/config',", "router.put('/n8n/config',", "router.post('/n8n/test',",
            "router.get('/n8n/workflows',", "router.put('/n8n/workflows',", "router.get('/n8n/diagnostics',",
            "router.post('/n8n/enable-for-org',", "router.get('/n8n/permissions',", "router.put('/n8n/permissions',",
        ]) {
            expect(source).toContain(marker);
        }
        expect(
            absentTokens(source, [
                'configured', 'hasApiKey', 'workflows', 'activeWebhookCount', 'n8nConfigured',
                'enabledIntegrationsIncludesN8n', 'source', 'userLevel', 'passes', 'reason',
                'modify_n8n_workflows', 'toolsThatWillBeInjected', 'availableGroups', 'orgAdminAlways',
            ]),
        ).toEqual([]);
        // A saved workflow's keys are the ones the tool builder reads back.
        expect(absentTokens(read('integrations/n8nTools.js'), ['webhookPath', 'httpMethod', 'allowKbIngestion', 'inputs'])).toEqual([]);
    });

    it('Nextcloud sync, pairing codes and the meeting-notes settings keep their keys', () => {
        const sync = read('routes/admin/ncSync.js');
        expect(
            absentTokens(sync, ['mode', 'syncGroups', 'excludedGroups', 'newUserDefaultStatus', 'lastSyncAt', 'ncBaseUrl', 'users']),
        ).toEqual([]);
        // Sync now answers the sync service's own counts.
        expect(absentTokens(read('services/ncUserGroupSync.js'), ['created', 'deactivated', 'skipped'])).toEqual([]);
        const pairing = read('auth/ncBindingRoutes.js');
        expect(absentTokens(pairing, ['generate', 'codes'])).toEqual([]);
        expect(pairing).toContain('/pairing-codes/:id');
        // Both saves replace the stored document, so the phone sends back every
        // key it read; each must still be one the (strict) body accepts.
        const talk = read('routes/talkNotesSettings.js');
        expect(
            absentTokens(talk, [
                'autoTranscribe', 'postSummaryBack', 'recordingFolder', 'language', 'autoRecord', 'autoRecordScope',
                'recordingMode', 'insightsPerPersonStats', 'defaultOwnerUserId', 'excludedEventUids', 'excludedRoomTokens',
            ]),
        ).toEqual([]);
        const meet = read('routes/gmeetNotesSettings.js');
        expect(
            absentTokens(meet, [
                'autoImport', 'autoRecordConfig', 'importScope', 'language', 'lookbackHours', 'excludedEventIds', 'excludedMeetingCodes',
            ]),
        ).toEqual([]);
    });

    it('GitHub sync keeps its routes and the status and item keys', () => {
        const source = read('routes/integrations/githubSync.js');
        for (const route of ['/status', '/details', '/configure', '/push', '/push-pending']) expect(source).toContain(`'${route}'`);
        expect(absentTokens(source, ['githubConnected', 'configured', 'repoOwner', 'repoName', 'branch', 'autoSync', 'results'])).toEqual([]);
        // The config and the per-item rows come from the store.
        expect(
            absentTokens(read('stores/githubSyncStore.js'), [
                'lastFullSync', 'resource_type', 'resource_id', 'sync_status', 'last_synced_at', 'error_message',
            ]),
        ).toEqual([]);
    });

    it('the Azure configuration keeps its sections, its keys and the group-sync routes', () => {
        const source = read('routes/orgAzureConfig.js');
        for (const section of ["'openai'", "'chatModels'", "'docProcessing'", "'sso'"]) expect(source).toContain(section);
        expect(
            absentTokens(source, [
                'azureEndpoint', 'hasAzureApiKey', 'azureModels', 'chatModelTiers',
                'useAzureDocProcessing', 'hasAzureDocKey', 'hasAzureEmbedKey', 'ssoClientId',
                'hasSsoClientSecret', 'ssoTenantId', 'autoApproveSSO', 'groupSyncSettings', 'groupSyncStatus',
            ]),
        ).toEqual([]);
        expect(source).toContain("router.post('/:orgId/sync-groups',");
        expect(source).toContain('res.json({ ok: true, settings })');
        expect(
            absentTokens(read('integrations/azureGroupSync.js'), [
                'synced', 'details', 'errors', 'lastSyncAt', 'lastSyncResult', 'syncedGroups', 'syncedUsers',
                'destructiveSync', 'autoActivateUsers', 'periodicSync', 'syncIntervalHours',
            ]),
        ).toEqual([]);
    });
});

describe('the chat answer, its cards and its composer (features/chat)', () => {
    const MOBILE = path.resolve(__dirname, '../../..');
    const mine = (rel: string) => fs.readFileSync(path.join(MOBILE, rel), 'utf8');

    /** The keys of `const <name> = z.object({ … })` — its top-level fields, four spaces in. */
    function schemaKeys(source: string, name: string): string[] {
        const start = source.indexOf(`const ${name} = z.object({`);
        if (start < 0) return [];
        const body = source.slice(start, source.indexOf('\n}', start));
        return [...body.matchAll(/^ {4}(\w+):/gm)].map((m) => m[1] as string);
    }

    /** `export const NAME = [ 'a', 'b', … ] as const;` out of a phone source file. */
    function listIn(source: string, name: string): string[] {
        const start = source.indexOf(`export const ${name} = [`);
        const body = source.slice(start, source.indexOf('] as const', start));
        return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
    }

    it('posts back only keys each draft route’s strict schema accepts (draftPayloads.ts)', () => {
        const phone = mine('src/features/chat/model/draftPayloads.ts');
        const routes: [string, string, string][] = [
            ['GMAIL_KEYS', 'routes/integrations/gmail.js', 'EmailBody'],
            ['OUTLOOK_KEYS', 'routes/integrations/outlook.js', 'EmailBody'],
            ['CALENDAR_KEYS', 'routes/integrations/calendar.js', 'CalendarAction'],
            ['CONTACTS_KEYS', 'routes/integrations/contacts.js', 'ContactsAction'],
            ['KEEP_KEYS', 'routes/integrations/keep.js', 'KeepAction'],
        ];
        for (const [list, file, schema] of routes) {
            const accepted = schemaKeys(read(file), schema);
            expect(accepted.length).toBeGreaterThan(2);
            expect({ list, refused: listIn(phone, list).filter((k) => !accepted.includes(k)) }).toEqual({ list, refused: [] });
        }
        expect(schemaKeys(read('routes/integrations/linkedin.js'), 'PostBody')).toEqual(['text']);
        for (const file of ['calendar', 'contacts', 'keep']) {
            expect(read(`routes/integrations/${file}.js`)).toContain("router.post('/execute',");
        }
        expect(read('routes/integrations/linkedin.js')).toContain("router.post('/post',");
    });

    it('answers a DLP review with the decision body the route reads, marks included', () => {
        const route = read('routes/dlpDecision.js');
        expect(schemaKeys(route, 'DecisionBody')).toEqual(['decisionId', 'choice', 'rememberForConversation', 'manualAdditions']);
        expect(schemaKeys(route, 'ManualMark')).toEqual(['offset', 'length']);
        expect(route).toContain("z.enum(['redact', 'block', 'allow']");
    });

    it('dictates through a multipart `audio` with a `language`, and reads `text` back', () => {
        const route = read('routes/dictate.js');
        expect(route).toContain("upload.single('audio')");
        expect(route).toContain('req.body.language');
        expect(route).toContain("text: result.text || ''");
        expect(route).toContain('MAX_BYTES = 25 * 1024 * 1024');
    });

    it('shares a conversation into a project thread and back', () => {
        // The thread routes live in routes/projects/threads.js, mounted by
        // routes/projects.js. Taking a chat back out is its owner's call.
        expect(read('routes/projects.js')).toContain("router.use('/', require('./projects/threads').makeThreadsRouter({");
        const threads = read('routes/projects/threads.js');
        expect(threads).toContain("router.post('/:id/threads', requireRole('editor'), validate({ body: S.ShareThreadBody })");
        expect(threads).toContain("router.delete('/:id/threads/:convId', requireOwnThreadMw, validate({ query: S.TypeQuery })");
        expect(absentTokens(read('routes/projects/schemas.js'), ['conversationId', 'conversationType'])).toEqual([]);
        expect(read('stores/agent/sharedConversations.js')).toContain("shared_scope = 'project'");
    });

    it('stores a chat’s knowledge bases with the PATCH and answers what it stored', () => {
        const routes = read('routes/ai/directChat/conversationRoutes.js');
        expect(routes).toContain('return res.json({ success: true, knowledgeBaseIds: nextKbIds });');
        expect(routes).toContain('payload.knowledgeBaseIds = await usableKbIdsForRequest(req, conv.knowledgeBaseIds);');
        expect(absentTokens(routes, ['invalid'])).toEqual([]);
    });

    it('reads the shield status and the composer flags from the keys the server sends', () => {
        expect(
            absentTokens(read('routes/privacyShieldStatus.js'), ['enabled', 'source', 'action', 'failMode', 'guardReachable', 'euMode', 'coworkEnabled']),
        ).toEqual([]);
        expect(
            absentTokens(read('routes/ai/config/userSettings.js'), ['orgEnabledIntegrations', 'hasGoogleKey', 'hasElevenLabsKey', 'searchProvider', 'enabledApps']),
        ).toEqual([]);
    });

    it('files a rating with a comment and, when asked, the conversation', () => {
        const feedback = read('routes/feedback.js');
        expect(absentTokens(feedback, ['comment', 'conversationSnapshot', 'messageId', 'rating', 'source'])).toEqual([]);
    });

    it('persists the parts of an answer the phone reads back (messageReader.ts)', () => {
        const finalize = read('routes/ai/directChat/finalizeRows.js');
        expect(
            absentTokens(finalize, ['thinkingParts', 'toolHistory', 'emailDrafts', 'calendarDrafts', 'mapEmbeds', 'audioFiles', 'tokenisationInfo', 'autoSelectedTier']),
        ).toEqual([]);
    });
});
