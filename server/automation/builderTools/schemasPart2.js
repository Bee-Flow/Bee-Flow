// @typecheck
// Part 2 of the TOOL_SCHEMAS array (split out of schemas.js; order is preserved there).

const { BINDING_HINT, WHOLE_RUN_DOCTRINE, SPLICE_DESCRIPTION } = require('./schemaFragments');
const { CONDITION_RULES_HINT } = require('./ruleExamples');

/** @type {Array<{ type: string, function: { name: string, description: string, parameters: object } }>} */
const TOOL_SCHEMAS_PART_2 = [
    {
        type: 'function',
        function: {
            name: 'builder_add_ai_step',
            description: `Append an AI reasoning step that transforms or summarises upstream data. By default no tool calls — set allowTools:true (and optionally a tools allowlist) when this step needs to fetch data on its own (web search, Gmail lookup, etc.). The user's per-org integration permissions are still enforced at runtime. Use this for: extracting structured fields from text, summarising, classifying, drafting reply text, OR (with allowTools) free-form research that doesn't fit a static integration_action. Split your instructions: put the role/persona/tone/output-style in \`systemPrompt\` and the concrete per-run task + data references in \`prompt\`. To have an EXISTING agent do the step instead of writing a persona by hand, set \`agentId\` (and, deliberately, whichever of \`agentPermissions\` the user asks for — every one you omit is off). ${BINDING_HINT} EXAMPLE — extract invoice fields from EACH email the previous forEach step read (chained forEach, no loop container): {systemPrompt:"You are a meticulous bookkeeping assistant. Respond only with valid JSON.",prompt:"Extract amount, currency, vendor, dueDate from this invoice email.",inputs:{emailBody:{kind:"ref",path:"loop.r.output.body"}},forEach:{overRef:"steps.a_1a2b3c.output.results",itemVar:"r"},outputSchema:{type:"object",properties:{amount:{type:"number"},currency:{type:"string"},vendor:{type:"string"},dueDate:{type:"string"}}},modelTier:"fast"}.`,
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: SPLICE_DESCRIPTION },
                    systemPrompt: { type: 'string', description: 'Optional. The role/persona/output-style instruction for the AI (the system prompt) — e.g. "You are a meticulous financial analyst. Always answer in Dutch." Put WHO the model is and HOW it should behave here; put WHAT to do this run (the task + data references) in `prompt`. Omit for trivial one-off transforms to use the default automation-step system prompt.' },
                    prompt: { type: 'string', description: 'The task instruction for this run. Reference the inputs by name. Put persona/tone/output-style in `systemPrompt`, not here.' },
                    inputs: { type: 'object', description: `Map of binding-name to a binding object. ${BINDING_HINT}` },
                    outputSchema: { type: 'object', description: 'JSON schema describing the desired structured output. Strongly recommended so downstream steps can reference fields.' },
                    modelTier: { type: 'string', description: 'MUST be one of the tiers listed under "ai_step modelTier" in the system prompt — those are the only tiers configured for this user; anything else is rejected. Default: auto (classifier picks the tier per prompt complexity).' },
                    allowTools: { type: 'boolean', description: 'Default false. When true the AI step can call the user\'s integration tools (web search, gmail_search, etc.). Use sparingly — most steps should bind upstream integration_action output instead.' },
                    tools: { type: 'array', items: { type: 'string' }, description: 'Optional allowlist of tool names the AI step may call. Empty / omitted = whatever allowTools dictates.' },
                    useMemory: { type: 'boolean', description: 'Default false. When true the step is grounded in the automation owner\'s personal memory (what they told the chat assistant about themselves, their preferences and their contacts): the memories most relevant to this step\'s prompt are added to the system prompt before the model answers. Use for steps that write in the owner\'s name or decide on their behalf (reply drafts, briefings, prioritising); never for pure data transforms.' },
                    knowledgeBaseIds: { type: 'array', items: { type: 'string' }, description: 'Optional. Ids of knowledge bases to ground this step in — searched ONCE per run (keyed off the automation owner\'s own knowledge bases, never a per-user picker) and injected into the system prompt as reference material before the model answers. Use for steerable reference content (a brand style guide, a positioning doc, a policy) the step should follow without hardcoding it into the prompt. Never invent an id — take it from the "Knowledge bases you may use" block in the context (or one the user named); anything else is refused at save.' },
                    agentId: { type: 'string', description: 'Optional. Id of an EXISTING agent that does the thinking for this step: its published role, its knowledge and its tools replace the bare step. The agent must belong to the automation owner\'s own organisation and be published — an id that was deleted, sits in another workspace or was never published all get the SAME refusal (`ai_step.agent_unavailable`), so this is not a way to find out which agents exist elsewhere. Never invent one: take it from the "Agents you may use" block in the context (or one the user named); anything else is refused at save and refused again at run time.' },
                    skillIds: { type: 'array', items: { type: 'string' }, description: 'Optional. Ids of skills to apply to this step, MOST IMPORTANT FIRST — the first one is the leading skill (its output fields are merged into the step\'s own). At most 5 are used; anything past that is ignored. Works with or without `agentId`. Never invent an id.' },
                    disabledAgentSkillIds: { type: 'array', items: { type: 'string' }, description: 'Optional, only with `agentId`: ids of the AGENT\'s own skills this step does not use. The step\'s own `skillIds` are never affected and stay leading. Omit to use every skill the agent has.' },
                    agentPermissions: {
                        type: 'object',
                        description: 'Optional, and only meaningful together with `agentId`: what the agent may do INSIDE this step. Exactly three booleans — startAutomations, useKnowledge, useTools — and every one you leave out is FALSE. There is no "unset means everything" here: omit the object and the agent answers from its role alone, with no knowledge bases, no tools and no ability to start other automations. Ask the user before turning any of them on.',
                        properties: {
                            startAutomations: { type: 'boolean', description: 'Default false. May the agent start other automations from this step? Only automations the AUTOMATION OWNER can already run AND the agent\'s owner granted it.' },
                            useKnowledge: { type: 'boolean', description: 'Default false. May the agent search its own knowledge bases here? Each one is still re-checked against the automation owner, so a base they may not read is dropped.' },
                            useTools: { type: 'boolean', description: 'Default false. May the agent call its integration tools here? Anything that would need a person to confirm it is left out — nobody is watching an automation run — so add an approval step after this one if the work has to be confirmed.' },
                        },
                    },
                    temperature: { type: 'number', minimum: 0, maximum: 2, description: 'Optional, 0 to 2 (default 0.2). Lower: the same input gives the same answer more often. Above 1 the answers vary a lot between runs. Leave it out unless the user asks for more or less variation.' },
                    enumFrom: {
                        type: 'array',
                        maxItems: 10,
                        description: 'Optional. Limits an answer field to values that exist in the run data. The allowed values (the list at `ref`, read from `value` in each item, or the plain items when `value` is left out) are SHOWN to the model AND checked after the answer: a value outside the list fails the answer. `field` must be declared in outputSchema ("category"; "tags[]" = every item of a list field; "items[].category" = a field inside list items). ref is a plain run path (steps.<id>.output.<list>, trigger.output.<list>, vars.<name>, loop.<var>): no {{ }}, never secrets. ignoreCase defaults to true; allowEmpty (default false) lets the field stay empty. EXAMPLE: [{field:"category",ref:"steps.s1.output.rows",value:"name"}]. At most 10 entries.',
                        items: {
                            type: 'object',
                            properties: {
                                field: { type: 'string', description: 'The answer field, e.g. "category", "tags[]" or "items[].category".' },
                                ref: { type: 'string', description: 'Plain run path to the list of allowed values, e.g. "steps.s1.output.rows".' },
                                value: { type: 'string', description: 'Path inside one list item to its value, e.g. "name". Leave out when the list holds plain text or numbers.' },
                                ignoreCase: { type: 'boolean', description: 'Default true.' },
                                allowEmpty: { type: 'boolean', description: 'Default false.' },
                            },
                            required: ['field', 'ref'],
                            additionalProperties: false,
                        },
                    },
                    checks: {
                        type: 'array',
                        maxItems: 20,
                        description: 'Optional. Checks run on the answer AFTER the model replied; they are never sent to the model. An answer that fails gets ONE automatic repair round (the model is told what is wrong); if it still fails, `fallback` applies (default: the step fails with errorClass ai_check_failed, which an error branch can route). Kinds: allowedFrom {field, ref, value?} = the text is one of the values in a list; numbersFrom {field, ref, tolerance?, ignoreUpTo?, percent?, ignoreDates?} = every number in the text also appears in the source at ref (a summary of figures from a table: field "summary", ref "steps.s2.output.totals"); script {field, script, minRatio?} = the text is written in that writing system (latin, cyrillic, greek, arabic, hebrew, han, japanese, hangul, devanagari, thai); items {field, minItems?, maxItems?, sameCountAs?} = a list field has that many items (sameCountAs = a run path to another list). EXAMPLE: [{kind:"numbersFrom",field:"summary",ref:"steps.s2.output.totals"},{kind:"items",field:"tags",minItems:1,maxItems:5}]. At most 20 checks.',
                        items: {
                            type: 'object',
                            properties: {
                                kind: { type: 'string', enum: ['allowedFrom', 'numbersFrom', 'script', 'items'] },
                                field: { type: 'string', description: 'The answer field to check, declared in outputSchema.' },
                                ref: { type: 'string', description: 'allowedFrom / numbersFrom: plain run path to the list or data to compare with.' },
                                value: { type: 'string', description: 'allowedFrom: path inside one list item to its value. Leave out for a list of plain text.' },
                                ignoreCase: { type: 'boolean', description: 'allowedFrom: default true.' },
                                allowEmpty: { type: 'boolean', description: 'allowedFrom: default false.' },
                                tolerance: { type: 'number', description: 'numbersFrom: how far a number may differ from the source (absolute). Default 0.' },
                                ignoreUpTo: { type: 'integer', description: 'numbersFrom: whole numbers up to this value are not checked (0..1000, default 0).' },
                                percent: { type: 'boolean', description: 'numbersFrom: a percentage may be written as a share or a number. Default true.' },
                                ignoreDates: { type: 'boolean', description: 'numbersFrom: numbers that are part of a date are not checked. Default true.' },
                                script: { type: 'string', enum: ['latin', 'cyrillic', 'greek', 'arabic', 'hebrew', 'han', 'japanese', 'hangul', 'devanagari', 'thai'], description: 'script: the writing system the text must be in.' },
                                minRatio: { type: 'number', description: 'script: the share of letters that must be in that writing system, 0..1 (default 1).' },
                                minItems: { type: 'integer', description: 'items: at least this many items (0..10000).' },
                                maxItems: { type: 'integer', description: 'items: at most this many items (0..10000).' },
                                sameCountAs: { type: 'string', description: 'items: plain run path to another list that must have the same number of items.' },
                            },
                            required: ['kind', 'field'],
                            additionalProperties: false,
                        },
                    },
                    fallback: {
                        type: 'object',
                        description: 'Optional. What happens when the answer still fails its checks after the repair round. {kind:"fail"} (the default when enumFrom or checks are set) stops the step with an error. {kind:"value", fields:{<answer field>: binding}} makes those values the WHOLE answer, notes a warning on the run, and drops every other field: list EVERY field that later steps read (steps.<id>.output.<field>), or it is undefined there. EXAMPLE for an answer with category and summary: {kind:"value",fields:{category:{kind:"literal",value:"Other"},summary:{kind:"literal",value:""}}}. At most 50 fields.',
                        properties: {
                            kind: { type: 'string', enum: ['fail', 'value'] },
                            fields: { type: 'object', description: 'kind "value": top-level answer field name -> binding. These values become the whole answer, so include every field a later step reads.' },
                        },
                        required: ['kind'],
                    },
                    askOnce: {
                        description: 'Optional. Reuse the answer when the same question (same prompt, data, model and settings) comes up again instead of asking the model again. true = within this run (repeated identical items); {ttlSeconds:1..900} shortens the window; {acrossRuns:true} also keeps it for LATER runs, which stores the answer and only works when the organisation allowed "Answers from AI steps" in its integration cache settings. Never used when the step may call tools.',
                        properties: {
                            ttlSeconds: { type: 'integer', description: '1..900 (default 300).' },
                            acrossRuns: { type: 'boolean', description: 'Keep the answer for later runs too. Needs the organisation setting "Answers from AI steps".' },
                        },
                    },
                    branch: { type: 'string', enum: ['then', 'else'], description: 'When afterStepId is a condition: which branch this step begins. Omit to auto-fill (then first, else second).' },
                    caseName: { type: 'string', description: 'When afterStepId is a switch: the case name (or "default") this step begins.' },
                    label: { type: 'string' },
                },
                required: ['prompt'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_condition',
            description: `Append an if/else branch. The expr reads the values of earlier steps (steps.<id>.output.<field>, trigger.output.<field>, loop.<var>.<field>) with comparisons, && / || and the rule helpers. EXAMPLES: "steps.parse.output.amount > 1000", "equals(trigger.output.status, \\"open\\")", "contains(steps.s1.output.subject, \\"invoice\\")", "isEmpty(steps.s1.output.results)". Use the rule shapes below with such a path in place of item.<field>. ${CONDITION_RULES_HINT} ${WHOLE_RUN_DOCTRINE} To grow a branch, call builder_add_action / builder_add_ai_step / builder_add_notification with afterStepId set to this condition\'s id — the edge is AUTO-labelled "then" on the first append and "else" on the second. Pass branch:"then"|"else" on that call to be explicit. Use thenStepId/elseStepId here only to wire EXISTING steps as branches.`,
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: SPLICE_DESCRIPTION },
                    expr: { type: 'string', description: 'The rule, true takes the "then" branch: comparisons, && / ||, and the helpers (contains, startsWith, endsWith, equals, isEmpty, anyOf, fileType, len, …). Never lower()/upper().' },
                    thenStepId: { type: 'string', description: 'Optional id of an existing step to wire as the "then" branch.' },
                    elseStepId: { type: 'string', description: 'Optional id of an existing step to wire as the "else" branch.' },
                    branch: { type: 'string', enum: ['then', 'else'], description: 'When afterStepId is itself a condition: which of ITS branches this nested condition begins. Omit to auto-fill (then first, else second).' },
                    caseName: { type: 'string', description: 'When afterStepId is a switch: the case name (or "default") this condition begins.' },
                    label: { type: 'string' },
                },
                required: ['expr'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_loop',
            description: `RARELY NEEDED — read this before using it. For per-item work, CHAIN per-step \`forEach\` instead: a second forEach over the first one's \`output.results\` still sees its own item (\`loop.<v>.item\` is the original, \`loop.<v>.output\` is that item's result), so "read each file, then extract from each file" is TWO flat forEach steps, NOT a loop. A loop also fails ALL-OR-NOTHING — one bad item aborts the whole run — whereas chained forEach records the failure per item and carries on, so the flat form is more correct as well as simpler.
Use a loop ONLY when the per-item body genuinely needs a SUB-DAG: body steps that branch (a condition inside the body), or two steps that must both read the SAME source item without one consuming the other's aggregate output.
The body is a sub-DAG run once per item; refer to the current item as loop.<itemVar>. ${BINDING_HINT} EXAMPLE — a body that BRANCHES, which is what justifies a loop: {overRef:"steps.a_1.output.rows",itemVar:"row",maxIterations:50,body:[{type:"condition",expr:"loop.row.total > 1000"},{type:"notification",title:"Large amount",body:"{{loop.row.id}}"}]}. IMPORTANT: every body step MUST have a "type" field; the system will assign ids if missing.`,
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: SPLICE_DESCRIPTION },
                    overRef: { type: 'string', description: 'Path to the array, e.g. steps.search.output.items.' },
                    itemVar: { type: 'string', description: 'Loop variable name; available inside body as loop.<itemVar>.' },
                    body: { type: 'array', description: 'Sub-DAG step objects (linear). Each must include "type". "id" is auto-assigned if missing.' },
                    maxIterations: { type: 'integer', description: 'Cap, default 100, max 1000.' },
                    branch: { type: 'string', enum: ['then', 'else'], description: 'When afterStepId is a condition: which branch this step begins. Omit to auto-fill (then first, else second).' },
                    caseName: { type: 'string', description: 'When afterStepId is a switch: the case name (or "default") this step begins.' },
                    label: { type: 'string' },
                },
                required: ['overRef', 'itemVar'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_code_step',
            // NO ctx.secrets in this description, deliberately. It was listed here
            // for a long time while the runner had no secret store behind it at all
            // (runState.secrets is initialised to {} and never written), so a model
            // that took this description at its word wrote ctx.secrets('stripe_key'),
            // got null at run time, and shipped a step that authenticated to a third
            // party with nothing. The capability now throws instead of returning
            // null, and advertising a throw to the author is worse than saying
            // plainly that there is no secret access — so we say it plainly.
            //
            // The parameters paragraph is the step's input FORM: the step
            // settings parse the JSDoc on main (automation/codeSafety,
            // analyzeCode().params) and render one field per @param, with its
            // description as the help text, so a person who never reads the
            // code can fill it in. A code step whose inputs are not declared
            // shows them as bare "Other inputs" with no explanation.
            description: 'Append a sandboxed JavaScript step, for work no integration and no declarative step expresses. Code receives `inputs` and `ctx` (ctx.log, ctx.http for HTTPS to public hosts, ctx.integrations.<tool> for the tools in allowedTools). There is NO secret access from code: ctx.secrets() throws, and declaring secretKeys makes the step fail — any credential or key the code needs must come in through `inputs`, or via an integration tool that carries its own credentials. Define `async function main(inputs, ctx)` and return the result. What main returns is the step\'s `output.result`: bind a returned object\'s field as `steps.<id>.output.result.<field>` (never `steps.<id>.output.<field>` — `output` also carries `logs` and `httpCalls`), a returned list as `steps.<id>.output.result`. PARAMETERS: put a JSDoc block on main with a first line saying what the step does and one `@param {type} inputs.<name> - <short description a non-programmer understands>` per input the code reads (`[inputs.name]` optional, `[inputs.name=value]` with a default; types string, number, integer, boolean, object, array, string[], \'a\'|\'b\' choices, date, datetime, email, url); the step settings show these as a form, and the keys of `inputs` below are those names. Write ctx.http URLs as literal https:// strings so the safety check can see where data goes. Memory, CPU, wall clock and the ctx.http call budget are yours to set through `limits` (see that parameter) — within the sandbox ceiling, which refuses anything above it.',
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: SPLICE_DESCRIPTION },
                    code: { type: 'string', description: 'JavaScript source: a JSDoc block (what the step does, then one `@param {type} inputs.<name> - <description>` per input), then `async function main(inputs, ctx) { ... return result; }`.' },
                    inputs: { type: 'object', description: 'One binding per declared @param, keyed by its name: {amount:{kind:"ref",path:"steps.<id>.output.total"}}. A param with a default may be left out.' },
                    outputSchema: { type: 'object', description: 'The shape of what main returns. Later steps read it under steps.<id>.output.result.' },
                    allowedTools: { type: 'array', items: { type: 'string' }, description: 'Tool names this step may call via ctx.integrations.<tool>(args).' },
                    // The sandbox has clamped these four on every run since it
                    // was written, but no caller could name them: applyAddCode
                    // hardcoded three of them and ignored whatever was asked
                    // for, and this schema did not mention the block at all.
                    // So the ceiling was real and the dial was missing — a
                    // step that needed eight seconds of wall clock for a slow
                    // API had no way to say so. The ranges are stated here
                    // rather than left to be discovered, because the model's
                    // code runs for the first time in the USER's dry run: it
                    // cannot learn a ceiling by hitting it. Out of range is
                    // REFUSED (with the real bound named), never clamped —
                    // being quietly handed something other than what you asked
                    // for is how a step comes to lie about what it runs with.
                    limits: {
                        type: 'object',
                        description: 'Optional resource ceiling for this step. Omit for the defaults (memoryMb 64, cpuMs 1000, wallMs 5000, httpBudget 5). Ask for what the step needs and no more: code steps run IN-PROCESS, so a fat limit slows every other run on the same host. A value outside its range is refused, not clamped.',
                        properties: {
                            memoryMb: { type: 'integer', description: 'Isolate heap in MB. 8..256, default 64.' },
                            cpuMs: { type: 'integer', description: 'V8 CPU time in ms. 50..10000, default 1000. Raise it for heavy in-memory work, never for waiting.' },
                            wallMs: { type: 'integer', description: 'Wall clock in ms, ctx.http waits included. 100..30000, default 5000. This is the one to raise for a slow API.' },
                            httpBudget: { type: 'integer', description: 'How many ctx.http calls the step may make. 0..20, default 5. Set 0 for code that must not reach the network at all.' },
                        },
                        additionalProperties: false,
                    },
                    branch: { type: 'string', enum: ['then', 'else'], description: 'When afterStepId is a condition: which branch this step begins. Omit to auto-fill (then first, else second).' },
                    caseName: { type: 'string', description: 'When afterStepId is a switch: the case name (or "default") this step begins.' },
                    label: { type: 'string' },
                },
                required: ['code'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_notification',
            description: `Append a notification step that delivers a result to the user. The title and body are TEMPLATES — interpolate upstream data with double curly braces. EXAMPLE: {title:"Monthly invoice report",body:"Found {{steps.search.output.count}} invoices totalling €{{steps.sum.output.total}}",channels:["notification"]}. For Gmail-delivered notifications, instead use builder_add_action with tool gmail_compose.`,
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: SPLICE_DESCRIPTION },
                    title: { type: 'string', description: 'Template string. Supports {{steps.<id>.output.<path>}}.' },
                    body: { type: 'string', description: 'Template string. Supports {{steps.<id>.output.<path>}}.' },
                    channels: { type: 'array', items: { type: 'string' }, description: 'Default: ["notification"].' },
                    branch: { type: 'string', enum: ['then', 'else'], description: 'When afterStepId is a condition: which branch this step begins. Omit to auto-fill (then first, else second).' },
                    caseName: { type: 'string', description: 'When afterStepId is a switch: the case name (or "default") this step begins.' },
                    label: { type: 'string' },
                },
                required: ['title'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_http_request',
            description: `Append an HTTP Request step that calls an external API or webhook (e.g. a Slack/Google-Chat/Grafana incoming webhook, or any REST endpoint). This is the RIGHT tool whenever the user wants to POST/GET to an arbitrary URL — do NOT tell them to use n8n or a code step for a plain HTTP call. url/headers/body are TEMPLATES: interpolate upstream data with double curly braces, e.g. url:"https://chat.googleapis.com/v1/spaces/AAA/messages?key=..." body:'{"text":"{{steps.ai.output.result}}"}'. Output is {status,ok,headers,body,truncated,data} — bind to it downstream. body is the raw TEXT; data is that same body already PARSED when the response is JSON, so point arrayRef/repeat_for_each at data (an array), never at body (a string). parseResponse controls this: auto (default, parse when the content-type says JSON), never, always. EXAMPLE (Google Chat webhook): {url:"https://chat.googleapis.com/v1/spaces/AAA/messages?key=K&token=T", method:"POST", headers:{"Content-Type":"application/json"}, body:'{"text":"Test message"}'}. Security: blockPrivateTargets defaults TRUE (blocks localhost / private-network / cloud-metadata targets); set it false ONLY when the user explicitly needs to reach an internal/self-hosted address.`,
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: SPLICE_DESCRIPTION },
                    url: { type: 'string', description: 'Full https/http URL. Template string — supports {{trigger.output.x}} / {{steps.<id>.output.<path>}}.' },
                    method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'], description: 'Default GET. Use POST for most webhooks.' },
                    headers: { type: 'object', description: 'Map of header name → template-string value, e.g. {"Content-Type":"application/json"}. Do NOT put API keys/tokens in headers — set `authConnectionId` to a saved HTTP credential id instead, or tell the user to add one in the step\'s Authentication settings.' },
                    body: { type: 'string', description: 'Request body (raw text or JSON), only used for POST/PUT/PATCH/DELETE. Template string.' },
                    query: { type: 'object', description: 'Query parameters as DATA, instead of hand-encoding them into the URL (PREFER THIS for anything beyond ?a=b; never write %5B%5D by hand). {mode:"json", json:\'{"builder":[{"orderByDesc":"created_at"},{"with":["categories"]},{"paginate":{{steps.start.output.pageSize}}}]}\'} or {mode:"fields", items:[{key:"page", value:"{{trigger.output.page}}"}]}. Nested objects and arrays are serialised for you (default arrayFormat "indices": builder[0][paginate]=5, the qs/n8n/PHP style; or "brackets" a[]=x, "repeat" a=x&a=y, "comma" a=x,y). Keys and values are templates; in JSON mode a bound number stays a number. Empty values are dropped. Keep the URL for scheme, host and path; bind dynamic parts (the domain, a page size) to earlier step outputs. Parameters here win over the same key already in the URL. Never put API keys in query values: use a saved credential.', properties: { mode: { type: 'string', enum: ['fields', 'json'] }, json: { type: 'string', description: 'mode json: the parameters as JSON text, {{…}} allowed.' }, items: { type: 'array', description: 'mode fields: rows.', items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } } } }, arrayFormat: { type: 'string', enum: ['indices', 'brackets', 'repeat', 'comma'] } } },
                    timeoutMs: { type: 'number', description: 'Request timeout in ms, 1000..60000 (default 10000).' },
                    parseResponse: { type: 'string', enum: ['auto', 'never', 'always'], description: "How to fill `output.data`. auto (default): parse when the response content-type says JSON. never: leave it text-only. always: parse whatever the content-type claims — for APIs that answer JSON as text/plain." },
                    blockPrivateTargets: { type: 'boolean', description: 'Default true — block localhost/private/metadata targets. Set false ONLY for an internal endpoint the user explicitly asked to reach.' },
                    authConnectionId: { type: 'string', description: 'Id of a saved HTTP credential (org vault); its auth header is injected at run time and never stored in the flow. Only set when the user supplied one; never invent ids.' },
                    askOnce: { description: 'Reuse the answer to this call instead of asking again. GET/HEAD ONLY — on a write method the validator rejects the step, because a reused answer to a POST means the second POST silently never happens. Also never reused when blockPrivateTargets is false. `true` = reuse within one run (the shape that collapses a 200-row forEach into one call); `{acrossRuns:true}` additionally keeps the answer for LATER runs, which stores it and only works if an org admin allowed it for web service calls. `{ttlSeconds:N}` (1..900) shortens the window. Use it for a rate-limited or per-call-billed reference API that a loop hits once per row.' },
                    cacheInto: { description: 'Keep the answers to this call as ROWS in a datatable, so the same question is not paid for twice across days and the answers can be read, corrected and exported. `{datatableId:"tbl_…", maxAgeDays:30}`. GET/HEAD only, and nothing is kept while blockPrivateTargets is false — the same refusals askOnce has. The table must be one the user provisioned for this (managedKind "http_cache"): its columns are fixed and it is the only kind the step editor picker offers. Independent of askOnce — either can be on alone. NOTE, and tell the user: rows are ORDINARY plaintext table rows that everyone with access to that table can read and export, unlike the encrypted store askOnce uses; and old rows are removed by the retention window on the table itself, not by a hidden timer. Only set this when the user asked for their API answers to be kept somewhere they can see them; never invent a datatableId.' },
                    branch: { type: 'string', enum: ['then', 'else'], description: 'When afterStepId is a condition: which branch this step begins.' },
                    caseName: { type: 'string', description: 'When afterStepId is a switch: the case name (or "default") this step begins.' },
                    label: { type: 'string' },
                },
                required: ['url'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_generate_document',
            description: `Append a step that renders text into a real PDF or Word (.docx) file and keeps it so the automation can hand it over. Use it whenever the user wants "a PDF", "a Word document", "an offer/report/quote as a file", or something downloadable. \`content\` is a TEMPLATE — bind it to whatever produced the text, e.g. content:"{{steps.ai_1.output.blogtekst}}". Markdown is the default and is rendered properly (headings, bold, links, lists, tables). Output is {fileId,filename,mimeType,size,format}; there is deliberately NO url. TO OFFER IT AS A DOWNLOAD: add a form_page (mode:"ending") whose form.fields contains {type:"download", label:"…", fileId:"{{steps.<this step's id>.output.fileId}}"} — the form builds the session-scoped download link itself. The file is deleted after \`expiresInDays\` (default 7), so it is not a permanent store.`,
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: SPLICE_DESCRIPTION },
                    content: { type: 'string', description: 'The document text. Template string — normally a single reference like {{steps.<id>.output.<field>}}.' },
                    contentFormat: { type: 'string', enum: ['markdown', 'html'], description: 'How to read `content`. Default markdown, which is what AI steps produce. Use html only when the text upstream is already markup.' },
                    layout: { type: 'string', enum: ['document', 'slides'], description: 'Default document (linear print layout). "slides" renders the PDF as a landscape DECK: the h1 becomes the cover, every h2 becomes its own slide with a title band — the shape of an advisory/bank presentation. The author steers the deck with headings, so tell the writing step to keep each h2-section one page. Word output stays a linear document either way.' },
                    format: { type: 'string', enum: ['pdf', 'docx'], description: 'Default pdf. Use docx when the user wants to edit it in Word.' },
                    title: { type: 'string', description: 'Heading on the first page and the default filename. Template string.' },
                    fileName: { type: 'string', description: 'Filename WITHOUT extension (that follows from `format`). Template string. Falls back to the title.' },
                    expiresInDays: { type: 'number', description: 'How long the download keeps working, 1..90 (default 7). The file is deleted afterwards.' },
                    branch: { type: 'string', enum: ['then', 'else'], description: 'When afterStepId is a condition: which branch this step begins.' },
                    caseName: { type: 'string', description: 'When afterStepId is a switch: the case name (or "default") this step begins.' },
                    label: { type: 'string' },
                },
                required: ['content'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_fill_document',
            description: `Append a step that fills a DESIGNED document — an invoice, a quote, an order confirmation, a letter on the company's letterhead — with this run's values and keeps the PDF.

WHICH DOCUMENT STEP TO USE. \`builder_add_generate_document\` turns TEXT into a file and lays it out with the standard renderer: a report, a summary, whatever an ai_step just wrote. THIS one renders a layout somebody drew by hand in Studio → Documents and that must come out identical every time, with the amounts in the right column. Text in → generate_document. A form to fill → fill_document.

\`documentId\` MUST come from the "Documents you may fill" block — never invent one, and never create the document yourself; the person designs it. If that block says the user has none, say so and stop.

\`values\` keys are the placeholder names EXACTLY as that block lists them ("customer.name", "lines"). Each value is a template string, normally one reference: {"customer.name":"{{steps.extract.output.naam}}"}. A (list) placeholder must be bound to a WHOLE ARRAY — write it as a single "{{steps.rows.output.rows}}" and nothing else: mixed text ("Klant {{x}}") is interpolated into a string, and a list that arrives as text renders as nothing.

A placeholder with no value prints BLANK (never its own braces), and the step's output names every hole that stayed empty, so bind them all.

Output is {fileId, filename, mimeType, size, documentId, missing[]} — the same file shape send_email attachments, approval attachments and a form_page download field already take. There is deliberately NO url. The file is deleted after \`expiresInDays\` (default 7).`,
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: 'Default false: the new step is added BESIDE the current successor of afterStepId (that edge stays, so the two run in parallel). true: INSERT the new step between afterStepId and its current successor(s) - the successor edge is re-pointed to the new step, so downstream steps can depend on it. Pass branch/caseName as well when the anchor is a condition/switch.' },
                    documentId: { type: 'string', description: 'Id of an EXISTING document of this user, from the "Documents you may fill" block. Never invent one.' },
                    documentVersionId: { type: 'string', description: 'Pinned versionId from builder_read_document.' },
                    sectionOverrides: { type: 'object', description: 'Reviewed section ID to automatic/include/exclude choices.' },
                    values: { type: 'object', description: 'Placeholder name → value. Template strings ("{{steps.x.output.total}}"); a list placeholder takes a single whole-array reference and nothing else.' },
                    fileName: { type: 'string', description: 'Filename WITHOUT the .pdf extension. Template string, e.g. "Factuur {{steps.extract.output.nummer}}". Falls back to the document\'s own name.' },
                    saveCopy: { type: 'boolean', description: 'Default false. true ALSO keeps the filled-in document in Studio → Documents, so a person can correct a line by hand before it goes out. Leave it off for an automation that runs often — it mints a document every run.' },
                    format: { type: 'string', enum: ['pptx', 'pdf'], description: 'Only for a PRESENTATION document (docType "presentation" in the block): pptx (default) or pdf. A page document is always a PDF.' },
                    expiresInDays: { type: 'number', description: 'How long the file stays fetchable, 1..90 (default 7).' },
                    branch: { type: 'string', enum: ['then', 'else'], description: 'When afterStepId is a condition: which branch this step begins.' },
                    caseName: { type: 'string', description: 'When afterStepId is a switch: the case name (or "default") this step begins.' },
                    label: { type: 'string' },
                },
                required: ['documentId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_slide',
            description: `Append ONE slide of a presentation — no file, a cheap building block for builder_add_presentation. \`title\` and \`content\` are templates; content is markdown: "- " bullets (two-space indent = sub-point), a paragraph, a "|" table, a "> " quote, "![](url)" image, "### " sub-headings (two = columns, three to six = cards with a short text each; "### Title {icon: shield}" gives a card a Lucide icon, an image line inside the block a picture) — the LAYOUT IS PICKED FROM WHAT THE CONTENT CONTAINS, or forced with \`layout\`. VISUALS: \`chart\` draws a chart from data rows ({type:"bar", data:"{{steps.query.output.rows}}"} — ONE slide, no loop), \`stats\` makes KPI tiles, layout "timeline" turns the bullets into numbered steps. Output is {slide} (an object). Use forEach to make one slide per row: {title:"{{loop.r.name}}", content:"- Omzet: {{loop.r.omzet}}", forEach:{overRef:"steps.rows.output.rows", itemVar:"r"}}. PREFER pattern (1) of builder_add_presentation — one ai_step that writes the whole outline — when the slides do not come from data rows.`,
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: 'Default false: the new step is added BESIDE the current successor of afterStepId (that edge stays, so the two run in parallel). true: INSERT the new step between afterStepId and its current successor(s) - the successor edge is re-pointed to the new step, so downstream steps can depend on it. Pass branch/caseName as well when the anchor is a condition/switch.' },
                    title: { type: 'string', description: 'Slide heading. Template string.' },
                    content: { type: 'string', description: 'Slide body as markdown. Template string — e.g. "- {{steps.extract.output.punt1}}\\n- {{steps.extract.output.punt2}}".' },
                    notes: { type: 'string', description: 'Speaker notes — what the presenter says. Template string.' },
                    layout: { type: 'string', enum: ['auto', 'title', 'section', 'bullets', 'two_column', 'cards', 'table', 'image', 'quote', 'chart', 'stats', 'timeline', 'closing'], description: 'Default auto (from the content). "section" = a divider with just the title; "cards" = 3–4 "### " blocks as cards; "timeline" = the bullets as numbered steps ("Title — text"); "closing" = the final thank-you slide.' },
                    image: { type: 'string', description: 'Optional image: the imageUrl of a generate_image step, or a data: URL. Template string. Remote http(s) pictures are not fetched.' },
                    chart: {
                        type: 'object',
                        description: 'Optional chart: {type:"bar", data:"{{steps.query.output.rows}}", labels:"maand", values:"omzet,kosten"} — data may be rows, a markdown table or "label: value" lines; labels/values name the columns and are auto-detected when omitted.',
                        properties: {
                            type: { type: 'string', enum: ['column', 'bar', 'line', 'area', 'pie', 'donut'] },
                            data: { description: 'The data: a whole reference "{{steps.<id>.output.rows}}", a markdown table, "label: value" lines, or inline rows.' },
                            labels: { type: 'string', description: 'Column that holds the labels (optional).' },
                            values: { type: 'string', description: 'Comma-separated columns to plot (optional).' },
                            stacked: { type: 'boolean' },
                            unit: { type: 'string', description: 'Axis unit, e.g. "%" or "€".' },
                        },
                    },
                    stats: { type: 'string', description: 'Optional KPI tiles, one per line "value | label | delta | icon" (max 4), e.g. "{{steps.q.output.total}} | Omzet | +12% | trending-up". Template string.' },
                    style: { type: 'string', enum: ['accent', 'dark'], description: 'Paint this one slide in the accent colour or dark, for emphasis. Leave out otherwise.' },
                    forEach: { type: 'object', description: 'Run once per item of an upstream list: {overRef:"steps.<id>.output.<list>", itemVar:"r", maxIterations?:100}. The presentation step then takes steps.<this id>.output.results[*].output.slide.' },
                    branch: { type: 'string', enum: ['then', 'else'], description: 'When afterStepId is a condition: which branch this step begins.' },
                    caseName: { type: 'string', description: 'When afterStepId is a switch: the case name (or "default") this step begins.' },
                    label: { type: 'string' },
                },
                required: ['title'],
            },
        },
    },
];

module.exports = { TOOL_SCHEMAS_PART_2 };
