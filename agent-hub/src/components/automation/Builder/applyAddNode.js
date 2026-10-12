import { branchFromHandle } from './flow/branchEdges';
import { seedPositions } from './flow/layout';
import { normalizeDefinitionShape, emptyGraph } from './flow/normalizeDefinition';
import { defaultFormPageDeclaration, defaultFormEndingDeclaration } from './flow/settings/FormBuilderFields';
import { MAX_AI_STEP_SKILL_IDS } from './flow/settings/formState';
import { defaultFormDeclaration } from './flow/settings/FormTriggerFields';
import { ROUTE_STEP_NAME } from './flow/stepDisplayName';
import { defaultTriggerLabel } from './flow/triggerLabels';

function newStepId(kind) {
    const prefix = kind === 'integration_action' ? 'act'
        : kind === 'ai_step' ? 'ai'
        : kind === 'data_extraction' ? 'ex'
        : kind === 'condition' ? 'cond'
        : kind === 'loop' ? 'loop'
        : kind === 'notification' ? 'notif'
        : kind === 'code' ? 'code'
        : kind === 'trigger' ? 'trig'
        : 'step';
    const rand = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID().split('-')[0]
        : Math.random().toString(36).slice(2, 10);
    return `${prefix}_${rand}`;
}

/**
 * Translate a palette payload into a fully-scaffolded step / trigger.
 * Exported so the slide-in NodePalette can use it for click-to-add
 * without re-implementing the per-kind defaults.
 *
 * Triggers are special: they replace `definition.trigger` rather than
 * appending to `definition.steps`.
 */
export function buildStepFromPayload(payload, position) {
    if (!payload || !payload.kind) return null;
    // 'create_layer' is a palette meta-action handled by BuildTab's
    // handleAddNode (create flowlet + insert call_layer + drill in) — it is
    // not a step. Dropping it on the canvas is a no-op.
    if (payload.kind === 'create_layer') return null;
    if (payload.kind === 'trigger') {
        // Shape mirrors server-side emptyDefinition() in
        // server/automation/builderTools.js — the validator requires
        // `type: 'trigger'` plus an `output` map (the runtime payload
        // for manual/schedule triggers is empty until run-time).
        //
        // `asSecondaryTrigger` (set by the ribbon's "+ add another trigger"
        // affordance, webhook/app_event only) appends to
        // `definition.triggers[]` instead of replacing the one primary
        // `definition.trigger` — see automation/validate.js's `triggers[]`
        // rules, which reject schedule/manual there.
        return {
            [payload.asSecondaryTrigger ? '__addTrigger' : '__replaceTrigger']: true,
            id: newStepId('trigger'),
            type: 'trigger',
            kind: payload.triggerKind || 'manual',
            label: payload.label || defaultTriggerLabel(payload.triggerKind || 'manual'),
            output: {},
            // A form trigger drops in already WORKING — title, three questions,
            // a thank-you message and a preset. Refining is optional; an empty
            // form would be a dead end that also blocks activation.
            ...(payload.triggerKind === 'form' ? { form: defaultFormDeclaration() } : null),
            position: position || { x: 0, y: 0 },
        };
    }
    const id = newStepId(payload.kind);
    // Defaults are chosen to pass server-side `validateDefinition`:
    //   - required string fields (prompt, expr, overRef, code, title)
    //     are non-empty so the validator's *_missing checks pass
    //   - `condition.expr` defaults to `true` so the parser accepts it
    // These are obviously placeholder values the user will replace via
    // the inspector — they're not meant as final content.
    const baseStep = { id, type: payload.kind, position: position || { x: 0, y: 0 } };
    if (payload.kind === 'integration_action') {
        baseStep.tool = payload.tool || '';
        baseStep.label = payload.label || payload.tool || 'Integration';
        baseStep.inputs = {};
        // appId lets the inspector list sibling operations of the same app
        // (the single-node operation switcher); sideEffect (from the catalog,
        // authoritative over the node's name heuristic) drives the ⚡ badge
        // and dry-run skipping. Both are optional for older drag payloads.
        if (payload.appId) baseStep.appId = payload.appId;
        if (payload.sideEffect != null) baseStep.sideEffect = payload.sideEffect;
    } else if (payload.kind === 'ai_step') {
        baseStep.prompt = 'Describe what the AI should do here.';
        baseStep.modelTier = 'auto';
        baseStep.allowTools = false;
        baseStep.inputs = {};
        baseStep.label = payload.label || 'AI step';
        // "Use an agent" / "Apply a skill" from the ribbon, or an agent or
        // skill dragged out of Studio (handoff 5, round 3). The permissions
        // start all off, as when an agent is picked in the step editor: an
        // agent's reach outside the step is something the author turns on.
        if (typeof payload.agentId === 'string' && payload.agentId) {
            baseStep.agentId = payload.agentId;
            baseStep.agentPermissions = { startAutomations: false, useKnowledge: false, useTools: false };
        }
        if (Array.isArray(payload.skillIds)) {
            // Capped like the editor and the runner cap it.
            const skillIds = [...new Set(payload.skillIds.filter((s) => typeof s === 'string' && s))].slice(0, MAX_AI_STEP_SKILL_IDS);
            if (skillIds.length) baseStep.skillIds = skillIds;
        }
    } else if (payload.kind === 'data_extraction') {
        // `source` stays ABSENT for the generate_document reason: it is the
        // "which text do I read" pointer, and a guessed one is a step that
        // quietly extracts from the wrong thing. Absent rather than null so no
        // reader ever meets `typeof null === 'object'` on a binding slot.
        // `data_extraction.source_missing` is a completeness code, so the gap
        // autosaves amber.
        //
        // `fields` seeds ONE blank row so the panel opens on a row to fill in,
        // not on an "Add field" link. The validator reads a nameless row as
        // `fields_missing` — completeness, like the empty list — so the seed
        // survives the first autosave; buildPatch drops it from the wire the
        // moment the panel saves anything, and extractFormState puts it back in
        // the draft whenever the list is empty.
        baseStep.fields = [{ name: '', type: 'string', description: '', required: false }];
        baseStep.label = payload.label || 'Extract data';
    } else if (payload.kind === 'condition') {
        baseStep.expr = 'true';
        baseStep.label = payload.label || 'Condition';
    } else if (payload.kind === 'tokenize') {
        // Same as the guard: no honest default for "what should I hide", and
        // autoMapStep binds it to the nearest upstream text on arrival.
        baseStep.sourceRef = payload.sourceRef || '';
        baseStep.label = payload.label || 'Hide personal data';
    } else if (payload.kind === 'untokenize') {
        baseStep.sourceRef = payload.sourceRef || '';
        baseStep.label = payload.label || 'Show real values again';
    } else if (payload.kind === 'guard') {
        // sourceRef is REQUIRED by the validator, and there is no honest
        // default for "what should I scan" — the panel asks, and the nearest
        // upstream value is offered as a one-click pick. A placeholder path
        // here would look configured while scanning nothing.
        baseStep.sourceRef = payload.sourceRef || '';
        baseStep.label = payload.label || 'Check for personal data';
    } else if (payload.kind === 'loop') {
        baseStep.itemVar = 'item';
        // EMPTY, like the collection ops below (C20 / A18): the old
        // 'trigger.output.items' literal looked configured but resolved to
        // nothing on most triggers, so the loop ran zero iterations and
        // reported success. Blank is safe to autosave — `loop.overRef_missing`
        // is in the server's COMPLETENESS_CODES, so it downgrades to an amber
        // activate-blocking warning — and mapping/autoMapInputs.js binds it
        // from the nearest upstream array the moment the node is connected
        // (isScaffoldOverRef already treated both '' and the old literal as
        // scaffold, so that heal path was written for this and never reachable).
        baseStep.overRef = '';
        baseStep.maxIterations = 100;
        baseStep.body = [];
        baseStep.label = payload.label || 'Loop';
    } else if (payload.kind === 'notification') {
        baseStep.title = 'Notification';
        baseStep.body = '';
        baseStep.channels = ['notification'];
        baseStep.label = payload.label || 'Notification';
    } else if (payload.kind === 'http_request') {
        baseStep.url = '';
        baseStep.method = 'GET';
        baseStep.headers = {};
        baseStep.body = '';
        baseStep.timeoutMs = 10_000;
        // Blocks localhost/private-network/cloud-metadata targets by
        // default — an OPTIONAL per-step toggle (not mandatory), see
        // server/core/automationRunner/engine.js's execHttpRequest.
        baseStep.blockPrivateTargets = true;
        baseStep.label = payload.label || 'HTTP Request';
    } else if (payload.kind === 'generate_document') {
        // `content` seeds EMPTY: it is the "where does the text come from"
        // pointer, and a plausible-looking default there is a step that
        // silently renders the wrong thing. Everything else gets a working
        // default so a freshly dropped node is one binding away from running.
        baseStep.content = '';
        baseStep.contentFormat = 'markdown';
        baseStep.format = 'pdf';
        baseStep.title = '';
        baseStep.fileName = '';
        baseStep.expiresInDays = 7;
        baseStep.label = payload.label || 'Make a document';
    } else if (payload.kind === 'slide') {
        baseStep.title = '';
        baseStep.content = '';
        baseStep.notes = '';
        baseStep.label = payload.label || 'Slide';
    } else if (payload.kind === 'presentation') {
        // `slides` seeds EMPTY: it is the "where do the slides come from"
        // pointer. Everything else gets a working default.
        baseStep.slides = '';
        baseStep.title = '';
        baseStep.subtitle = '';
        baseStep.fileName = '';
        baseStep.format = 'pptx';
        baseStep.houseStyle = true;
        baseStep.expiresInDays = 7;
        baseStep.label = payload.label || 'Presentation';
    } else if (payload.kind === 'fill_document') {
        // `documentId` seeds EMPTY for the same reason generate_document's
        // `content` does — it is the "which design" pointer, and guessing one
        // of the user's documents would render the wrong artefact convincingly.
        baseStep.documentId = '';
        baseStep.values = {};
        baseStep.fileName = '';
        baseStep.expiresInDays = 7;
        baseStep.label = payload.label || 'Fill a document';
    } else if (payload.kind === 'form_page') {
        // Dropped ready to run, like the trigger: a real question (or a real
        // closing message) so the node is publishable before it is edited.
        // `theme: null` inside the declaration means "match the first page".
        const ending = payload.mode === 'ending';
        baseStep.mode = ending ? 'ending' : 'input';
        baseStep.form = ending ? defaultFormEndingDeclaration() : defaultFormPageDeclaration();
        if (!ending) baseStep.waitSeconds = 3600;
        baseStep.label = payload.label || (ending ? 'Show a summary' : 'Ask for more info');
    } else if (payload.kind === 'code') {
        baseStep.code = '// async function main(inputs, ctx) {\n//   return inputs;\n// }\nreturn inputs;';
        baseStep.language = 'javascript';
        baseStep.label = payload.label || 'Code';
    } else if (payload.kind === 'set') {
        baseStep.fields = {};
        baseStep.label = payload.label || 'Edit data';
    } else if (payload.kind === 'parse_json') {
        // Empty fields is only a validation WARNING (parse_json.no_fields) —
        // deliberate, so a freshly-dropped node survives the autosave
        // round-trip before the user adds rows.
        baseStep.sourceRef = '';
        baseStep.mode = 'paths';
        baseStep.fields = [];
        baseStep.label = payload.label || 'Parse JSON';
    } else if (payload.kind === 'datetime') {
        baseStep.op = 'now';
        baseStep.label = payload.label || 'Date & Time';
    } else if (payload.kind === 'wait') {
        baseStep.seconds = 5;
        baseStep.label = payload.label || 'Wait';
    } else if (payload.kind === 'approval') {
        // Blank question, on purpose. There is no honest default for "what am
        // I asking?", and a plausible placeholder would reach a real approver
        // looking configured. approval.prompt_missing is a COMPLETENESS code,
        // so a fresh drop autosaves amber rather than failing red. The
        // DEADLINE does have an honest default, so the node is one edit away
        // from running.
        baseStep.prompt = '';
        baseStep.approval = { expiresInHours: 168 };
        baseStep.label = payload.label || 'Approval';
    } else if (payload.kind === 'stop_error') {
        baseStep.message = 'Halted';
        baseStep.label = payload.label || 'Stop and error';
    } else if (payload.kind === 'return_to_app') {
        // Dezelfde C20-regel als de tabel- en KB-stappen: NIETS gokken. Er is
        // geen eerlijke default voor "welk scherm", en een gegokt scherm stuurt
        // een bezoeker straks ergens heen waar hij niet hoort te zijn. Alleen
        // de terugvalkeuze wordt gezet, want die HEEFT een eerlijke default:
        // 'stay' laat de bezoeker staan waar hij staat.
        //
        // Een verse drop draagt dus `return_to_app.empty` — een
        // completeness-code, dus hij slaat amber op en blokkeert pas bij
        // activeren.
        baseStep.navigateTo = null;
        baseStep.toast = null;
        baseStep.refresh = null;
        baseStep.onError = 'stay';
        baseStep.label = payload.label || 'Back to the app';
    } else if (payload.kind === 'datatable') {
        // Same C20 rule as the collection ops: seed an EMPTY table id rather
        // than guessing one. An unfilled id shows a visible amber
        // `datatable.table_missing` chip (a completeness code, so it autosaves
        // fine and blocks activation) instead of silently pointing at whichever
        // table happened to be first.
        //
        // `op` seeds to find_rows because it is the ONLY operation that cannot
        // change anything — the same reasoning that seeds a Privacy Shield node
        // to 'check' rather than a destructive default.
        baseStep.op = 'find_rows';
        baseStep.datatableId = '';
        baseStep.where = [];
        baseStep.values = {};
        baseStep.limit = 50;
        baseStep.label = payload.label || 'Datatable';
    } else if (payload.kind === 'knowledge_write') {
        // Same C20 rule: an EMPTY base rather than a guessed one. Guessing is
        // worse here than for a datatable — a wrong table writes rows somebody
        // can delete, a wrong knowledge base writes text an agent will quote
        // back as fact. The blank shows the amber `knowledge_write.kb_required`
        // chip (a completeness code, so it autosaves and blocks activation).
        baseStep.knowledgeBaseId = '';
        baseStep.title = '';
        baseStep.content = '';
        // No default sourceUri: any value we invented would be the SAME on
        // every run, so the step would overwrite its own single document
        // forever and the author would never see why. Blank earns the
        // `no_source_uri` warning, which is the honest state.
        baseStep.sourceUri = '';
        baseStep.label = payload.label || 'To knowledge base';
    } else if (payload.kind === 'switch') {
        baseStep.expr = 'trigger.output.value';
        baseStep.cases = [{ name: 'case1', value: '' }];
        baseStep.defaultBranch = null;
        baseStep.label = payload.label || 'Switch';
    // Collection ops seed an EMPTY arrayRef (C20): auto-map fills it from the
    // nearest upstream array on connect, and an unfilled one shows a visible
    // amber `arrayRef_missing` chip (draft warning, blocks activation) instead
    // of the old 'trigger.output.items' literal that silently resolved to
    // nothing and ran the op as a green no-op on most triggers.
    //
    // Their `field` seeds are empty for the SAME reason (A18): 'id' and
    // 'amount' were placeholder guesses that looked configured, and a field
    // that is on no item makes Aggregate emit a list of undefineds and
    // Summarize total nothing and call it 0. There is no honest default for
    // "which field" — the panel asks, and offers the real fields of the source
    // list as one-click picks. `aggregate.field_missing` /
    // `summarize.field_missing` are both in COMPLETENESS_CODES, so blank
    // autosaves fine and warns amber until it is answered.
    } else if (payload.kind === 'filter') {
        baseStep.arrayRef = '';
        baseStep.expr = 'true';
        baseStep.label = payload.label || ROUTE_STEP_NAME;
    } else if (payload.kind === 'limit') {
        baseStep.arrayRef = '';
        baseStep.count = 10;
        baseStep.mode = 'first';
        baseStep.label = payload.label || 'Limit';
    } else if (payload.kind === 'dedupe') {
        baseStep.arrayRef = '';
        baseStep.label = payload.label || 'Remove duplicates';
    } else if (payload.kind === 'flatten') {
        baseStep.arrayRef = '';
        baseStep.keepEmpty = false;
        baseStep.label = payload.label || 'Flatten a list';
    } else if (payload.kind === 'aggregate') {
        baseStep.arrayRef = '';
        baseStep.field = '';
        baseStep.label = payload.label || 'Aggregate';
    } else if (payload.kind === 'summarize') {
        baseStep.arrayRef = '';
        baseStep.field = '';
        baseStep.op = 'sum';
        baseStep.label = payload.label || 'Summarize';
    } else if (payload.kind === 'call_layer') {
        // Inline flowlets: the step only carries the flowlet key — input/output
        // contracts derive live from definition.layers[layerKey] via
        // getLayerContract (no denormalised copies, no version pinning).
        baseStep.layerKey = payload.layerKey || '';
        baseStep.label = payload.label || 'Flowlet';
        baseStep.inputs = {};
    } else if (payload.kind === 'call_block') {
        // Reusable Steps: the step carries the external Step's id; its input /
        // output contract derives live from the Steps catalog (no version pin).
        baseStep.blockId = payload.blockId || '';
        baseStep.label = payload.label || 'Step';
        // Seed the node's symbol from the source Step so it reads the same on
        // the canvas; the user can override it in the inspector.
        if (payload.icon) baseStep.icon = payload.icon;
        baseStep.inputs = {};
    } else if (payload.kind === 'layer_output') {
        baseStep.fields = {};
        baseStep.label = payload.label || 'Return';
    } else if (payload.kind === 'note') {
        // A canvas annotation (BFSF-411) — no execution-relevant defaults to
        // seed, unlike every step above: `text` is genuinely empty until the
        // user writes something (NoteNode shows a "double-click to write a
        // note…" placeholder for it, the same way a blank prompt/expr does
        // for other freshly-dropped steps), and `size` is left UNSET so the
        // canvas's own default (flow/layout.js DEFAULT_NOTE_SIZE) applies —
        // seeding a literal here would just be a second place for that
        // default to drift from.
        baseStep.text = typeof payload.text === 'string' ? payload.text : '';
        baseStep.label = payload.label || 'Note';
    }
    return baseStep;
}

/**
 * Pure transform: given the current definition, a palette payload, a
 * drop position, and (optionally) a source node id to wire from, return
 * the next definition. Used by both the drag-drop path and the slide-in
 * panel's click-to-add path so the result is identical either way.
 */
export function applyAddNode(definition, payload, position, sourceId = null, sourceHandle = null) {
    const built = buildStepFromPayload(payload, position);
    if (!built) return definition;
    // Normalize FIRST so the trigger branches below can't inherit a base that
    // is missing `steps`/`edges`. They are key-preserving spreads, and
    // seedPositions early-returns once every node has a position — so without
    // this a `{}` base produced a trigger-only definition the server rejects
    // with "'steps' must be an array" (BFSF-318).
    const base = normalizeDefinitionShape(definition) || emptyGraph();

    if (built.__replaceTrigger) {
        const { __replaceTrigger, ...nextTrigger } = built;
        // Preserve existing trigger id so saved-state edges still resolve.
        if (base.trigger?.id) nextTrigger.id = base.trigger.id;
        return seedPositions({ ...base, trigger: nextTrigger });
    }

    if (built.__addTrigger) {
        // triggers[] is root-only: a flowlet/Step graph (layer_input trigger)
        // cannot carry secondary triggers — the validator rejects the whole
        // document (`triggers.not_supported_here`). The ribbon hides the
        // cluster in those scopes (C8); this guards programmatic paths.
        if (base.trigger?.kind === 'layer_input') return definition;
        const { __addTrigger, ...newTrigger } = built;
        return seedPositions({ ...base, triggers: [...(base.triggers || []), newTrigger] });
    }

    const nextSteps = [...base.steps, built];
    // A note (BFSF-411) is never wired, even when dropped ON a source node
    // or handle — BuildTab's `wirable` flag already keeps sourceId null for
    // notes on every real UI path, but this is the one place that would
    // actually MINT the edge, so it stays true regardless of what a caller
    // passes in.
    const nextEdges = (sourceId && built.type !== 'note')
        ? [...base.edges, { from: sourceId, to: built.id, ...branchFromHandle(sourceHandle) }]
        : base.edges;
    return seedPositions({ ...base, steps: nextSteps, edges: nextEdges });
}

/**
 * Would adding edge `from → to` create a cycle? Walks the existing
 * graph: if `from` is reachable from `to`, the new edge closes a loop.
 */
function createsCycle(def, from, to) {
    const adj = new Map();
    for (const e of (def.edges || [])) {
        if (!adj.has(e.from)) adj.set(e.from, []);
        adj.get(e.from).push(e.to);
    }
    const stack = [to];
    const seen = new Set();
    while (stack.length) {
        const cur = stack.pop();
        if (cur === from) return true;
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (const next of (adj.get(cur) || [])) stack.push(next);
    }
    return false;
}

export { createsCycle };
