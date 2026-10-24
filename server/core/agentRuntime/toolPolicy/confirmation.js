/**
 * CONSENT, not capability: must a person say yes before this call runs, and
 * WHOSE connection does it run on?
 *
 * `confirmForTool` is the hold-back verdict; `actAsForTool` is the raw `actAs`
 * reader and `mayLendOwnerConnection` is the gate both dispatch sites ask —
 * deliberately two functions, because the raw reader cannot tell "the owner
 * chose viewer" from "nobody wrote anything down" and the gate must.
 */

'use strict';

const { effectOf } = require('../../automationModel/sideEffectMap');
const { _plainObject, toolsConfigOf, CONFIRM_MODES, ACT_AS_MODES } = require('./configShape');
const { appIdForTool, isAttributionAvailable, _decidingApps, _warnDegraded } = require('./appIndex');
const { hasCuratedGrants } = require('./grantResolution');

/**
 * `direct` or `ask` for one tool.
 *
 *   reads  → always direct (there is nothing to approve)
 *   sends  → always ask    (whatever the config says)
 *   writes → the app entry's `confirm`, else `legacyDefault`
 *
 * `legacyDefault` is 'direct' on purpose: an agent that predates the picker
 * must not start asking for confirmation on writes it has always just done.
 */
function confirmForTool(toolName, toolsConfig, { legacyDefault = 'direct' } = {}) {
    const effect = effectOf(toolName);          // sideEffectMap — no registry involved
    if (effect === 'reads') return 'direct';
    if (effect === 'sends') return 'ask';
    // The opt-in boundary, here too: an agent without a grants map has no decision that can be looked up, so the registry is not
    // even touched. Without this shortcut every old agent would touch it on every turn anyway — precisely what "invisibly shippable" excludes.
    if (!_plainObject(toolsConfig)) return CONFIRM_MODES.includes(legacyDefault) ? legacyDefault : 'direct';
    const appId = appIdForTool(toolName);
    // Same rule as isToolAllowed: with attribution degraded, the owner's
    // `confirm` for this app cannot be found, and "I could not find the
    // decision" is not "there was none". Only for an agent that has grants —
    // an agent without one has no decision to lose.
    if (!appId && !isAttributionAvailable() && hasCuratedGrants(toolsConfig)) return 'ask';
    if (!appId) return CONFIRM_MODES.includes(legacyDefault) ? legacyDefault : 'direct';
    // If more than one app supplies this tool, the NARROWEST choice counts: one 'ask' anywhere is a confirmation that someone switched
    // on, and the other row may not push it aside. Without this only the choice of the owner of the name applied, and the `confirm`
    // on the other row was storable and dead.
    let sawDirect = false;
    for (const id of _decidingApps(appId, toolName)) {
        const entry = toolsConfig[id];
        if (!_plainObject(entry) || !CONFIRM_MODES.includes(entry.confirm)) continue;
        if (entry.confirm === 'ask') return 'ask';
        sawDirect = true;
    }
    if (sawDirect) return 'direct';
    return CONFIRM_MODES.includes(legacyDefault) ? legacyDefault : 'direct';
}

/**
 * 'viewer' | 'owner' for one tool — only ever 'owner' on a normalised config.
 *
 * The RAW reader: it answers with the module default ('viewer') whether the
 * owner chose that or said nothing at all. Dispatch must not use it directly —
 * see `mayLendOwnerConnection`, which keeps those two apart.
 *
 * Since A2-2 the two give the same answer on a CURATED agent, and that still does not make them interchangeable: on an agent that
 * nobody curated this function says 'viewer' while the gate (the opt-in boundary) does lend. Whoever asks his dispatch question
 * here asks it of the wrong one.
 */
function actAsForTool(toolName, toolsConfig) {
    const appId = appIdForTool(toolName);
    const entry = appId && toolsConfig ? toolsConfig[appId] : null;
    if (_plainObject(entry) && ACT_AS_MODES.includes(entry.actAs)) return entry.actAs;
    return 'viewer';
}

/**
 * May this call borrow the OWNER's connection? The `actAs` question in the
 * shape the dispatch sites need it, so both of them ask it the same way.
 *
 * ── ONLY A STORED YES LENDS (A2-2) ──────────────────────────────────
 * On a curated agent this lends only where the owner has STORED `actAs:
 * 'owner'`. No entry for this app, an entry without `actAs`, or an `actAs` that nobody can read: all three "nothing has been written
 * down", and nothing written down is no yes.
 *
 * Until A2-2 the missing entry gave `true` here, with the argument that
 * "curating Gmail is no statement about Outlook" — the same argument that holds for `actions`. For `actAs` it does not hold, and the
 * difference lies in what goes wrong when you make a mistake:
 *
 *   `actions`  is a CAPABILITY question. A missing entry read broadly gives the agent the tool belt it had yesterday too — nobody gets
 *              anything they did not already have, and reading too narrowly would silently strip an agent. Broad is the cautious side there.
 *   `actAs`    is an IDENTITY question. Reading broadly puts the LIVE connection of the owner (mailbox, Drive, calendar) under the fingers of
 *              ANOTHER person who runs the agent. Unknown must narrow there — the same rule that this function already applies two lines up
 *              (attribution broken ⇒ false) and in its catch (unreadable config ⇒ false), and that `normaliseToolsConfig` applies to
 *              `lentProviders === null` ("I could not check" is not a yes).
 *
 * And the screen already said so: the Tools card draws "As: the person asking" as soon as no `actAs` is stored (agent-hub
 * canUse/toolGrants.js → `storedActAsOf` is null ⇒ ACT_AS.VIEWER), and `actAsForTool` above answers that same state with 'viewer' too.
 * Two of the three readers therefore already said "the person asking"; only this gate lent. The side that the owner reads on his screen is the
 * side that must be correct — the other side costs the most and is invisible.
 *
 * ── WHICH AGENTS NOTICE THIS ────────────────────────────────────────
 * Only where ALL FIVE hold at the same time:
 *   1. `INTEGRATION_CONNECTION_LENDING_ENABLED` is on (default OFF, see integrations/connectionResolution.js);
 *   2. the agent has a CURATED map (`hasCuratedGrants`);
 *   3. the app of this tool has no entry there, or no readable `actAs` (normalisation writes one on every entry that it hands
 *      out, so this is an app that the owner never opened — or a map that the route skipped);
 *   4. the agent is run by someone other than the owner (`resolveEffectiveIdentity` never lends from yourself);
 *   5. there is a live lending grant from the owner for the provider of that app.
 * That call ran on the connection of the OWNER and now runs on that of the requester himself — with, if the requester has not connected
 * that app, a "not connected" instead of silently someone else's mailbox. The Tools card says so per row out loud (`ownerLendingUnset` in
 * canUse/toolGrants.js), so that this is not a silent change of behaviour but a visible one.
 *
 * ── WHAT REMAINS UNCHANGED ──────────────────────────────────────────
 *   SENDS ⇒ no, always. See the first line of the function: that is not a grant question but the floor under all three branches, and
 *   it therefore also holds on the non-curated agent below.
 *
 *   NOT CURATED ⇒ yes. The fence is `hasCuratedGrants`, not the presence of the key. `{}` — what `_clampRuntimeTools` and
 *   `applyConfigValidation` BOTH write back once a refused section was the only thing a map held — and junk-only maps are
 *   "exactly like no map" everywhere here; hanging the gate on the bare key would switch lending off for all those agents. An agent that
 *   nobody curated still lends as it did before this layer, and the card reports that on its turn (`ownerLendsUncurated`).
 *
 *   NOT TO SAY WHICH APP ⇒ no, for an agent with grants. The same rule as `isToolAllowed` and `confirmForTool`: with the attribution
 *   broken every name looks unknown, and "I could not find the owner's answer" is not "the owner said yes". With a healthy index a name
 *   that NO app claims still lends: a grant on an app can say nothing about a name that no app owns. Note — that is not inert: `providerForTool`
 *   recognises a provider by PREFIX, so a dynamically injected name outside the registry (`n8n_run_<slug>`) still lends here while the picker
 *   has no row for it to say yes on. That gap belongs to the tools-that-the-picker-cannot-show, not to this gate, and it is closed there.
 *
 * Total: it is read inside a dispatch path, so it never throws. An agentConfig
 * that cannot even be read at all lands on `false`, the closed side.
 */
function mayLendOwnerConnection(toolName, agentConfig) {
    try {
        // ── A SENDING TOOL NEVER LENDS (A2 contradiction) ───────
        // `normaliseToolsConfig` refuses `actAs: 'owner'` as soon as the grant contains a sends action ("a borrowed connection never sends
        // without the owner present"), and the card refuses the owner option on the same ground. That rule applied only on the CURATED
        // branch; the widest branch — an agent that nobody curated, which is every agent from before this layer — still lent
        // `signrequest_send_document` and `linkedin_create_post` under the name of the owner, sent by someone else. Nobody can
        // TICK that on, so it should not be possible to happen either.
        //
        // Ahead of the opt-in boundary, because it is not a grant question: it is the same floor as `confirmForTool`'s
        // `sends ⇒ ask`, and that one knows no exception for an agent without a map either.
        if (effectOf(toolName) === 'sends') return false;
        const cfg = toolsConfigOf(agentConfig);
        if (!hasCuratedGrants(cfg)) return true;
        const appId = appIdForTool(toolName);
        if (!appId) {
            if (isAttributionAvailable()) return true;
            _warnDegraded(`refusing the owner's connection for "${toolName}" on an agent with stored grants`);
            return false;
        }
        // Deliberately ONLY the entry of the app that owns the name, also when a second registry entry supplies the same tool
        // (`_decidingApps`). With `actions` and `confirm` those two both have a say because each of them can NARROW; identity is one
        // question about one credential, and `normaliseToolsConfig` refuses `actAs: 'owner'` on the app that lets its grants run
        // elsewhere (`appDefersGrants`) for that reason. Its `viewer` is therefore not a choice but the absence of one, and reading
        // that as a veto would make the row of the owner unusable.
        const entry = cfg[appId];
        // Only a stored yes. No entry, no `actAs`, and an unreadable `actAs` are the same answer: nothing is there, so nothing is lent —
        // precisely what the card draws for this state.
        return _plainObject(entry) && entry.actAs === 'owner';
    } catch (_) {
        return false;
    }
}

module.exports = { confirmForTool, actAsForTool, mayLendOwnerConnection };
