// @typecheck
/**
 * Keep the `automation` KB sources in step with an automation's definition, from
 * every path that saves one.
 *
 * ── WHY A SOURCE AT ALL, WHEN THE INGEST MAKES ONE ──────────────────
 * `integrations/kbIngestTools._ensureAutomationSource` already creates the row
 * — but LAZILY, on the first document. So between saving an automation and its
 * first successful run, the Knowledge Studio's Sources list says nothing is
 * feeding this base, while an automation sits armed to feed it. That gap is the
 * whole span in which somebody is deciding whether the base is trustworthy.
 *
 * The point of a source row here is not the ingest. It is the ANSWER to "where
 * did this come from, and what else is going to arrive" — asked by the person
 * looking at a knowledge base, not by the automation.
 *
 * ── WHY EVERY SAVE PATH ─────────────────────────────────────────────
 * The same rule `datatableUsageSync` states about itself, and for a sharper
 * reason: this reconcile also MARKS the sources a definition no longer names.
 * A save path that skips it leaves a source claiming an automation writes to a
 * base it stopped writing to a month ago — worse than no row, because the
 * Sources list is read as current. (Marks, never deletes — see the tail of
 * `syncKbSources` for why the documents stay.)
 *
 * ── NEVER THROWS ────────────────────────────────────────────────────
 * The source is bookkeeping; the automation is the product. A KB store that is
 * down must not make automations unsaveable. It also NEVER creates a source for a
 * base the automation's owner may not write to: an unauthorised step is refused at
 * activation and again at run time, and a source row for it would advertise a
 * feed that is never going to arrive.
 */

'use strict';

const { collectKbSteps } = require('./automationKbCheck');
const log = require('../../telemetry/log');

/** The config subset that identifies "this automation's source" in a base. */
function matchFor(automationId) {
    return { automationId };
}

/**
 * Reconcile one automation's `automation` sources.
 *
 * @param {string} automationId
 * @param {object} definition
 * @param {object} p
 * @param {string} p.userId          the automation's OWNER — whose write rights decide
 * @param {string} [p.title]         the automation's title, shown in the Sources list
 * @param {object} [p.deps]
 * @returns {Promise<{added: string[], kept: string[], removed: string[]}>}
 */
async function syncKbSources(automationId, definition, { userId, title = '', deps = {} } = /** @type {any} */ ({})) {
    const out = { added: [], kept: [], removed: [] };
    if (!automationId) return out;

    try {
        const kbSourcesStore = deps.kbSourcesStore || require('../../stores/kbSources');
        const { canOwnerWriteToKb } = deps.writeAccess || require('./kbWriteAccess');

        // The bases this definition WRITES to, deduplicated. A read link
        // (ai_step grounding) is not a source: nothing arrives because of it.
        const wanted = new Set(
            collectKbSteps(definition)
                .filter(s => s.access === 'write')
                .map(s => s.kbIds[0])
                .filter(Boolean),
        );

        // Only the ones the owner may actually write to. Checked here rather
        // than trusted from the definition for the reason kbWriteAccess states:
        // a stored definition records what somebody asked for, never that it
        // was allowed.
        const allowed = new Set();
        /**
         * Bases the CHECK could not answer for — a store outage, not a refusal.
         *
         * These must not be treated as "no longer written to". The stale pass
         * below marks anything outside `allowed`, so folding an outage into a
         * refusal relabelled every live source "(no longer writes here)" for
         * the duration of a blip, on an automation that had changed nothing.
         */
        const unknown = new Set();
        for (const kbId of wanted) {
            try {
                if ((await canOwnerWriteToKb(kbId, userId, { deps })).ok) allowed.add(kbId);
            } catch (_) {
                unknown.add(kbId);
            }
        }

        const name = String(title || '').trim() || `Automation ${automationId}`;
        for (const kbId of allowed) {
            const existing = await kbSourcesStore.findOne(kbId, 'automation', { configMatch: matchFor(automationId) });
            if (existing) {
                // A renamed automation renames its source. The name is the only
                // thing a person has to recognise it by in the Sources list.
                if (existing.name !== name) await kbSourcesStore.update(existing.id, { name });
                out.kept.push(kbId);
                continue;
            }
            await kbSourcesStore.create({
                knowledgeBaseId: kbId,
                kind: 'automation',
                name,
                config: { automationId, provider: 'automation', sourceType: 'automation_write' },
                createdBy: userId || null,
            });
            out.added.push(kbId);
        }

        /**
         * Sources this automation used to have and no longer does.
         *
         * Deliberately NOT deleted: a source row owns the documents hanging off
         * it, and `kb_sources` cascades to them. Removing the step from a
         * automation is not a request to delete last year's articles — that is a
         * decision for whoever owns the knowledge base, in the Knowledge
         * Studio, where they can see what they are about to lose.
         *
         * So the row is renamed to say what happened, and reported. A stale
         * source that says it is stale is honest; one that silently claims a
         * live feed is not, and one that vanishes with its documents is worse
         * than either.
         */
        if (typeof kbSourcesStore.listByAutomation === 'function') {
            const current = await kbSourcesStore.listByAutomation(automationId);
            for (const src of current) {
                if (allowed.has(src.knowledgeBaseId)) continue;
                // Still named by the definition, but the check could not run:
                // say nothing rather than say something false.
                if (unknown.has(src.knowledgeBaseId)) continue;
                // Still in the definition, but refused: that is a permission
                // problem the author has to fix, not a feed that stopped. Only
                // a base the definition DROPPED gets the stale label.
                if (wanted.has(src.knowledgeBaseId)) continue;
                const stale = `${name} (no longer writes here)`;
                if (src.name !== stale) await kbSourcesStore.update(src.id, { name: stale });
                out.removed.push(src.knowledgeBaseId);
            }
        }
    } catch (e) {
        log.warn(`[KB] Could not sync knowledge sources for automation ${automationId}: ${e.message}`);
    }
    return out;
}

module.exports = { syncKbSources };
