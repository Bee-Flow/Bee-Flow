/**
 * Agent tool policy — what an agent may call, and whether a person has to say
 * yes first.
 *
 * ── THE SHAPE ───────────────────────────────────────────────────────
 * `agent.config.tools` sits NEXT TO `enabledIntegrations`, which stays the
 * app-level on/off list (mobile and `isAppOn` read that one and must keep
 * working untouched):
 *
 *   config.tools = {
 *     [appId]:      { actions: string[] | '*', confirm: 'direct'|'ask', actAs: 'viewer'|'owner' },
 *     automations:  { [automationId]: { confirm } },
 *     datatables:   { [datatableId]: { scope: 'own'|'all', columns: string[] | '*' } },
 *   }
 *
 * `automations` and `datatables` are RESERVED keys — no integration may be
 * called either, and `RESERVED_TOOL_KEYS` is what every reader checks first.
 *
 * ── EVERY FIELD HERE IS ENFORCED, OR IT IS NOT STORED ───────────────
 * A saved restriction that nothing acts on is worse than no feature: the owner
 * reads it back and believes it. So each field names the thing that enforces
 * it:
 *   `actions`     the stack — isToolAllowed, applied inside `addTools`, which
 *                 is why an integration block that pushes onto the tool array
 *                 itself enforces nothing at all (the n8n block did, and its
 *                 grant was storable and inert until it stopped);
 *   `confirm`     the hold-back — confirmForTool + buildToolPolicy;
 *   `actAs`       the borrowed connection — mayLendOwnerConnection, read at
 *                 BOTH dispatch sites, streaming and non-streaming. A gate on
 *                 one of two dispatches is the same lie in a smaller room:
 *                 nobody can see which route their call took;
 *   `automations` which automations are offered and whether they ask first —
 *                 automationGrantsOf / automationConfirmsFor;
 *   `datatables`  which tables `datatable_query` will read, whose rows and
 *                 which columns — datatableGrantsOf, read by
 *                 core/tools/datatableTools.js at BOTH ends: the tool is only
 *                 offered for a granted table, and every call re-reads the
 *                 grant off the published config before it compiles a query.
 * Anything added here without an enforcement site belongs in the bin
 * `datatables` sat in until A1c: `normaliseToolsConfig` DROPPED it with a
 * warning for two releases, because it had been shaped and never wired and a
 * stored limit nothing applies is worse than no feature — the owner reads
 * "own rows, these columns" back and believes it. It is stored now because
 * `datatable_query` enforces both halves; the day something stops enforcing
 * them, this goes back in the bin rather than staying storable.
 * A refusal only counts if it reaches the ROW, so `applyConfigValidation`
 * (routes/agents) writes the clamped map back even when it clamps to `{}` —
 * keeping the raw map there handed the editor its refused limit straight back
 * on the next GET.
 *
 * ── NO MIGRATION, DELIBERATELY ──────────────────────────────────────
 * A missing entry, or `actions: '*'`, means "every action of this app" — which
 * is exactly today's behaviour, so every agent that exists before this lands
 * keeps its whole toolbelt without a data migration. The same rule covers the
 * confirm field: an agent with no entry for a tool gets `direct` for writes
 * (no behaviour change), while a tool added through the new picker arrives
 * with an explicit `confirm` on it.
 *
 * `actAs` is the EXCEPTION to that rule, and it is the only one — zie
 * `mayLendOwnerConnection`. Een ontbrekende entry leest daar NIET als "geen
 * beperking": `actions` en `confirm` gaan over wat de agent MAG, waar breed
 * lezen hem de toolbelt van gisteren teruggeeft, en `actAs` gaat over WIE hij
 * is, waar breed lezen de live verbinding van de eigenaar aan een ander
 * uitleent. Alleen een opgeslagen `actAs: 'owner'` leent.
 *
 * `sends` is the ONE thing no stored config can talk its way out of: a tool
 * that mails, posts or invites is always `ask`, which is what the product
 * already does today via the draft cards.
 *
 * ── NORMALISED ON WRITE **AND** ON READ ─────────────────────────────
 * `PUT /agents/:id`, mobile and the MCP builder all send `config` verbatim, so
 * validating only on write would leave a row that was written before this rule
 * existed — or by a client that skipped the route — running unclamped. Both
 * ends call `normaliseToolsConfig`, and it NEVER throws: a read that threw
 * would take a chat turn down, and "refuse the dangerous half" is the safer
 * failure anyway. Refusals come back as `warnings`, not exceptions.
 *
 * ── WHY THE ENFORCEMENT IS BY TOOL NAME ─────────────────────────────
 * `buildToolPolicy` turns the assembled stack into an `allowedToolNames` set,
 * and `toolRoundExecutor` refuses any name outside it BEFORE `executeTool`.
 * That is the gate that stops a hallucinated (or prompt-injected)
 * `automation_<id>` from reaching the dispatcher's dynamic-name fallback: the
 * model can only ever be honoured for a name that was actually offered — for
 * an agent someone has curated. It is opt-in like everything else here
 * (`enforceNames`, see `decideToolCall`); a legacy agent keeps the fallback it
 * has always had, and the unoffered name is logged rather than refused.
 *
 * ── WHY THE HOLD-BACK IS INERT WITHOUT A STORED MAP ─────────────────
 * `confirmByTool` is the POLICY verdict ("would a person have to say yes?").
 * `gatedTools` is the narrower question the runtime acts on: "must this call
 * be held back?" — and it is empty for every agent that has no `config.tools`
 * at all.
 *
 * That split is what makes this shippable invisibly. Today a `sends` tool
 * confirms itself: `gmail_compose` returns an `email_draft` instead of
 * sending, and a headless run flips that with `autoSend`. Holding those calls
 * back on the strength of `confirmByTool` alone would take the draft card away
 * from every agent that exists, and would stop every mailing automation dead.
 * So the hold-back only ever engages once someone has stored a `tools` map
 * with something in it — i.e. once the agent has been through the picker,
 * which is also where the confirm card gets drawn. An agent from before that
 * keeps its draft cards and its autoSend, byte for byte, and so does an agent
 * whose map is empty or unreadable AS STORED: `hasCuratedGrants`, not the mere
 * presence of the key, is what answers "has anyone curated this?".
 *
 * One caveat, because it is the kind of thing that is worse to discover than
 * to read: `normaliseToolsConfig` turns an UNREADABLE app entry into a stored
 * refusal (`{actions: []}`) rather than dropping it — dropping is what handed
 * such an app its whole toolbelt back — and a refusal is content, so the
 * CLAMPED map of an agent whose entries were all junk does count as a
 * curation. That agent enters the confirmation regime. It is the closed side
 * of the trade (a send is held back, never granted) and the warnings name the
 * entry that caused it.
 */

'use strict';

const {
    RESERVED_TOOL_KEYS, GATING_RESERVED_KEYS, CONFIRM_MODES, ACT_AS_MODES, DATATABLE_SCOPES,
    MAX_APP_ENTRIES, MAX_ACTIONS_PER_APP, MAX_AUTOMATION_GRANTS,
    MAX_DATATABLE_GRANTS, MAX_COLUMNS_PER_DATATABLE,
    toolsConfigOf,
} = require('./configShape');
const {
    appIdForTool, appIdForToolDef, actionsOfApp, isAttributionAvailable,
    appRequiresExplicitGrant, _resetAppIndex,
} = require('./appIndex');
const { allowedToolsFor, isToolAllowed, hasCuratedGrants } = require('./grantResolution');
const { automationGrantsOf, automationConfirmsFor, datatableGrantsOf } = require('./reservedGrants');
const { confirmForTool, actAsForTool, mayLendOwnerConnection } = require('./confirmation');
const { resolveLentProviders, lentAppsFor } = require('./connectionLending');
const { normaliseToolsConfig } = require('./normalisation');
const { buildToolPolicy, fallbackToolPolicy } = require('./turnPolicy');
const {
    decideToolCall, previewToolArgs, isUnattended, PREVIEW_MAX_KEYS, PREVIEW_MAX_STRING,
} = require('./callDecision');

module.exports = {
    RESERVED_TOOL_KEYS, GATING_RESERVED_KEYS, CONFIRM_MODES, ACT_AS_MODES, DATATABLE_SCOPES,
    MAX_APP_ENTRIES, MAX_ACTIONS_PER_APP, MAX_AUTOMATION_GRANTS,
    MAX_DATATABLE_GRANTS, MAX_COLUMNS_PER_DATATABLE,
    appIdForTool, appIdForToolDef, actionsOfApp, isAttributionAvailable,
    appRequiresExplicitGrant,
    toolsConfigOf, allowedToolsFor, isToolAllowed,
    confirmForTool, actAsForTool, mayLendOwnerConnection,
    automationGrantsOf, automationConfirmsFor, datatableGrantsOf, hasCuratedGrants,
    normaliseToolsConfig, resolveLentProviders, lentAppsFor,
    buildToolPolicy, fallbackToolPolicy, decideToolCall, previewToolArgs, isUnattended,
    PREVIEW_MAX_KEYS, PREVIEW_MAX_STRING,
    _resetAppIndex,
};
