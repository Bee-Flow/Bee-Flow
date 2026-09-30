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

const SERVER = path.resolve(__dirname, '../../../server');

function read(rel: string): string {
    return fs.readFileSync(path.join(SERVER, rel), 'utf8');
}

/** Concatenated source of every non-test .js file under a server directory. */
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
function functionSlice(source: string, fnName: string): string {
    const start = source.indexOf(`function ${fnName}(`);
    if (start === -1) return '';
    const rest = source.slice(start + 1);
    const next = rest.search(/\n(?:async )?function /);
    return source.slice(start, next === -1 ? undefined : start + 1 + next);
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
    // Mirrored by CoworkSchedule in src/features/cowork/api.ts. The plan for
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
    // src/features/automate/types.ts, which names this exact file as its source.
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
    // AppNotification in src/features/notifications/types.ts; `category`,
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
    // Mirrored by ConversationSummary in src/features/chat/types.ts. The list
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
    // Mirrored by Agent in src/features/agents/types.ts. `starter_prompts`
    // must stay string-or-array (parseConfig deliberately does not parse it —
    // parseStarterPrompts on the phone handles both).
    it('still declares every agent column the phone reads', () => {
        expect(
            absentTokens(read('stores/agent/initSchema.js'), [
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
    // src/features/library/types.ts. shared.js states the rule in its own
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
    // before any session exists (src/features/onboarding/api.ts SetupStatus).
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
    // checkServerSupport in src/api/server.ts treats a 404 from
    // /api/health/schema as "older than MIN_SERVER_BUILD" — which is only
    // sound while the endpoint exists and keeps this shape on every newer
    // server. Renaming any of these breaks the app's ability to SAY a server
    // is too old.
    it('still answers { ok, schemaReady, build }', () => {
        expect(absentTokens(read('routes/healthSchema.js'), ['ok', 'schemaReady', 'build'])).toEqual([]);
    });
});

describe('the direct-chat request body (server/routes/ai/directChat/)', () => {
    // The phone SENDS these (SendTurnPayload in src/features/chat/types.ts);
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
function routeSlice(source: string, marker: string): string {
    const start = source.indexOf(marker);
    if (start === -1) return '';
    const rest = source.slice(start + marker.length);
    const next = rest.search(/\nrouter\./);
    return source.slice(start, next === -1 ? undefined : start + marker.length + next);
}

/** Every `onEvent('x'` / `sendEvent('x'` literal in a chunk of server source. */
function emittedEventNames(source: string): string[] {
    const found = [...source.matchAll(/\b(?:onEvent|sendEvent)\s*\??\.?\(\s*'([a-zA-Z_0-9]+)'/g)];
    return [...new Set(found.map((m) => m[1] as string))].sort();
}

describe('skill rows (server/stores/skillStore.js)', () => {
    // Mirrored by Skill in src/features/skills/types.ts, which says in its own
    // header that it was written from `mapRow` rather than from the routes —
    // both GET routes hand back exactly what mapRow produces, so mapRow IS the
    // payload and the empty-string/`⚡` defaults it applies are load-bearing.
    const source = read('stores/skillStore.js');

    it('mapRow still maps every field the skill screens render', () => {
        expect(
            missingFrom(functionSlice(source, 'mapRow'), [
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
        // src/features/skills/types.ts), so a rename ships `workflow`, `rules`
        // and `examples` back unchanged. resolveBodyWrite reparses text into
        // structure, and parseWorkflowToSteps returns `refs: []` with freshly
        // minted step ids (server/core/skills/skillStructure.js:131-138). Only
        // this one guard — unchanged text means the facet is left alone —
        // stops every rename on a phone from wiping the refs a Studio user
        // attached and renumbering every step. Nothing else pins it: the
        // structured store tests cover the CHANGED-text branch and the rename,
        // never the full-snapshot PUT with unchanged text.
        const slice = functionSlice(source, 'updateSkill');
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

describe('transcription rows (server/stores/transcriptionStore.js)', () => {
    // Mirrored by TranscriptionSummary in src/features/recording/types.ts. The
    // three spread-in fields are conditional BY DESIGN (list payloads only, and
    // absent rather than empty when a query did not select them), so they are
    // pinned as assignments here — the optional `?:` on the phone matches.
    it('mapRow still maps every field the recording list renders', () => {
        expect(
            missingFrom(functionSlice(read('stores/transcriptionStore.js'), 'mapRow'), [
                'id', 'title', 'fileName', 'language', 'durationSeconds',
                'speakerCount', 'segmentCount', 'status', 'provider', 'source',
                'isPublished', 'sharedGroups', 'organizationId',
                'createdAt', 'updatedAt',
                'tags', 'transcriptSnippet', 'summarySnippet',
            ]),
        ).toEqual([]);
    });
});

describe('the form list (server/routes/automation/crud.js GET /forms)', () => {
    // Mirrored by FormSummary in src/features/publishing/types.ts, which names
    // this handler as its source. Assembled inline in the route rather than by
    // a row mapper, so the slice is the handler.
    const source = read('routes/automation/crud.js');
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
        // src/features/publishing/api.ts calls the absolute path. The list is
        // an explicit promise of the upgrade plan, and it is two halves that
        // move independently: the router-relative path here, and the mount in
        // index.js. Losing either one 404s the whole Forms tab.
        expect(source).toContain("'/forms'");
        expect(read('index.js')).toContain("'/api/automation'");
    });
});

describe('project rows (server/stores/projectStore.js)', () => {
    // Mirrored by Project in src/features/automate/types.ts. `permission` is
    // list-only (the detail route calls it `role`) and is computed by the
    // SELECT's CASE, so it is part of this mapper's contract, not the table's.
    // Each list row is the shared project mapper (mapProjectRow, which
    // getProject uses too) plus `permission`, so the mapped fields are the
    // union of both functions.
    it('listUserProjects still maps every field the solution screens read', () => {
        const store = read('stores/projectStore.js');
        const list = functionSlice(store, 'listUserProjects');
        expect(list).toContain('mapProjectRow(row)');
        expect(
            missingFrom(list + functionSlice(store, 'mapProjectRow'), [
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
        // src/features/agents/avatar.ts can only tell an emoji from a data:
        // URI, an http(s) URL and a '/'-relative path. Anything else renders as
        // its own characters, so an icon NAME would show the word; and
        // parseStarterPrompts JSON.parses a string — a column that starts
        // handing back a parsed object instead makes it throw. Both are TEXT
        // today and both mobile readers depend on that staying true.
        const schema = read('stores/agent/initSchema.js');
        expect(schema).toContain('avatar TEXT');
        expect(schema).toContain('starter_prompts TEXT');
    });
});

describe('meeting action items (server/core/meetingNotes/actionItems.js)', () => {
    // app/recordings/[id].tsx:327-329 sends the WHOLE list back on every tick
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
        // app/recordings/[id].tsx:327-329 sends the whole list back through a
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
    // useAgentChatStream.ts, either as a `case` (routed), in its
    // deliberately-ignored list (a decision), or here in NOT_YET_HANDLED (a
    // decision recorded on this side). Three ways to say yes, no way to say
    // nothing — the catalogLockstep NOT_YET_BUILT pattern. `tool_confirm`
    // shipped in the A-track and fell through to `default: onUnhandled` for
    // months precisely because nothing asked this question.
    //
    // `routes/agents` is in the scan because THAT is the endpoint the phone
    // opens: useAgentChatStream.ts:163 posts to /agents/:id/chat/stream, served
    // by routes/agents/chat.js — which emits three names of its own (:382
    // title_generated, :391 done, :400 error). Leaving it out was a real hole,
    // not a scope choice: `title_generated` occurs nowhere else in server/, so
    // renaming it there (or adding any new event beside it) left this test
    // green while the phone's `case 'title_generated':` went dead and every
    // Android chat kept the title "New Chat". Measured: with the rename in
    // place the whole mobile suite was 596/596 green.
    const stream = readTree('core/agentRuntime') + readTree('routes/ai') + readTree('routes/agents');
    const client = fs.readFileSync(
        path.resolve(__dirname, '../features/agents/useAgentChatStream.ts'),
        'utf8',
    );

    /**
     * Events the phone knowingly does not touch. Every entry is a decision,
     * not a backlog item — but a NEW name may never be added here without
     * looking at what it carries.
     */
    const NOT_YET_HANDLED = [
        // A different SSE endpoint entirely (routes/ai/automationBuilder/
        // suggestions.js — the web builder's integration scan). The phone does
        // not open that stream at all.
        'model',
        'scan_step',
        // Agent-runtime telemetry: which test-mode the turn ran in, what the
        // sandbox withheld, how the prompt tokenised, the raw pre-detokenised
        // answer, and which persona rule fired. All of it is Studio/debug
        // surface with no mobile screen behind it.
        'test_as',
        'test_chat',
        'test_sandbox',
        'tokenisation_info',
        'privacy_response_raw',
        'rule_attribution',
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
        // now an explicit ignore-case in useAgentChatStream.ts:430, so keeping
        // it here would be a stale decision hiding behind a green test. The
        // "no entry here is also routed" test below is what enforces that.
        //
        // `file` — A REAL GAP, RECORDED RATHER THAN SILENCED.
        // core/agentRuntime/toolRoundExecutor.js emits it when a tool BUILDS a
        // file (a deck, via the presentation renderer), and the web client
        // draws a card under the reply. The phone drops it, so a mobile user
        // who asks an agent for a presentation reads the model saying "here is
        // your deck" and never gets one. Nothing about that is deliberate; it
        // simply predates anyone asking this question on this side.
        //
        // It is listed instead of routed because routing it is not one line:
        // `image` above accumulates into `turn.images`, so `file` needs its own
        // field on the turn, a card to render it, a way to open or save it, and
        // persistence with the message — a feature, with UI that has to be seen
        // on a device to be believed. Listing it makes the gap a decision
        // someone can find; the "no entry here is also routed" test below stops
        // this line outliving the fix.
        'file',
    ];

    it('is either routed by the phone, ignored on purpose, or listed here', () => {
        const unaccounted = emittedEventNames(stream).filter(
            (e) => !client.includes(`case '${e}':`) && !NOT_YET_HANDLED.includes(e),
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
        expect(NOT_YET_HANDLED.filter((e) => client.includes(`case '${e}':`))).toEqual([]);
    });

    it('covers the stream the phone actually opens', () => {
        // Guard on the scan itself, not on its result. The three tests above
        // are only worth what `stream` contains, and the file that serves
        // /agents/:id/chat/stream slipped out of it once already. Moving that
        // handler to another tree is not an error anywhere — it just makes the
        // scan quietly stop covering the phone's own endpoint again.
        expect(emittedEventNames(readTree('routes/agents'))).toContain('title_generated');
        expect(read('routes/agents/chat.js')).toContain("router.post('/:id/chat/stream'");
        expect(client).toContain("case 'title_generated':");
    });
});
