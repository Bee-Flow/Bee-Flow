// @typecheck
/**
 * "This routine names a knowledge base — is that link still good?"
 *
 * ── WHY THIS IS NOT IN automation/validate.js ───────────────────────
 * `validate.js` is deliberately DB-free: it is the pure pass, run in the
 * builder, on import, and inside tests with no database behind them. Answering
 * this needs to read `knowledge_bases`, so it lives here and runs in the
 * ROUTE pass — the same split the approval-assignee rule already uses
 * (`validateApprovalAssignees`, called from the route for exactly this reason).
 *
 * ── WARNING WHILE BUILDING, ERROR WHEN GOING LIVE ───────────────────
 * A half-built routine is the normal state of a draft: the builder saves the
 * whole definition on every node edit, long before the flow is finished, and a
 * save blocked by an unfinished step is how you lose an afternoon's work. So a
 * draft gets a warning it can keep working past.
 *
 * Activation is different. That is the moment the routine starts running
 * unattended, on a schedule, with nobody watching the output — so a base it
 * cannot legitimately read is a hard refusal there. The runtime drops such an
 * id anyway (`execAi.resolveAllowedKnowledgeBaseIds`), which means without this
 * the routine would go live and quietly answer from less knowledge than its
 * author configured. Silently degraded is worse than refused.
 *
 * ── WHAT IT DOES NOT DO ─────────────────────────────────────────────
 * It does not decide who may READ the content — `core/kb/kbVisibility` does
 * that at retrieval, per run, against the person the routine runs as. This is
 * about the LINK: does the base exist, is it in this organisation, and did its
 * owner make it available to routines at all.
 *
 * ── READING AND WRITING ARE DIFFERENT QUESTIONS ─────────────────────
 * An `ai_step` READS from a base; a `knowledge_write` step PUTS something in
 * one. The second is the stricter question, and it is not answered by any of
 * the rules above: being allowed to read a handbook is not permission to add a
 * page to it. So a write link is checked against `canOwnerWriteToKb` — the
 * same predicate the runtime applies — and the run-time gate stays in place
 * regardless, because a definition is data and can arrive by import.
 */

const { kbUsableIn } = require('./usageContexts');

function isObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }

/**
 * Walk a graph's steps, descending into loop bodies and parallel branches —
 * the same nesting `validate.js`, `portability.js` and `stepContract.js` walk.
 * Copied rather than imported, for the reason `stepContract.js` states about
 * itself: this has to be safe to require from a route without dragging the
 * automation feature in behind it.
 */
function walkSteps(steps, fn) {
    if (!Array.isArray(steps)) return;
    for (const s of steps) {
        if (!isObject(s)) continue;
        fn(s);
        if (s.type === 'loop') walkSteps(s.body, fn);
        if (s.type === 'parallel' && Array.isArray(s.branches)) {
            for (const branch of s.branches) walkSteps(branch, fn);
        }
    }
}

/**
 * Every step that names a knowledge base, in the root graph and in each inline
 * layer, with a path in the shape the other findings use so the builder can put
 * the marker on the right node.
 *
 * `access` says which question to ask about it: `'read'` for an `ai_step`
 * grounding itself, `'write'` for a `knowledge_write` step adding to a base.
 */
function collectKbSteps(definition) {
    const found = [];
    const take = (layerKey) => (step) => {
        const path = layerKey ? `layers.${layerKey}.steps.${step.id || ''}` : `steps.${step.id || ''}`;

        if (step.type === 'ai_step') {
            if (!Array.isArray(step.knowledgeBaseIds)) return;
            const kbIds = step.knowledgeBaseIds.filter(v => typeof v === 'string' && v);
            if (!kbIds.length) return;
            found.push({ id: step.id || null, path, kbIds, access: 'read' });
            return;
        }

        if (step.type === 'knowledge_write') {
            const kbId = typeof step.knowledgeBaseId === 'string' ? step.knowledgeBaseId : '';
            // An unset target is `knowledge_write.kb_required` in the pure
            // validator, which runs on the same save. Reporting it twice, in
            // two different words, is how a builder ends up with two markers
            // on one node saying the same thing.
            if (!kbId) return;
            found.push({ id: step.id || null, path, kbIds: [kbId], access: 'write' });
        }
    };
    walkSteps(definition?.steps, take(null));
    const layers = isObject(definition?.layers) ? definition.layers : {};
    for (const [layerKey, layer] of Object.entries(layers)) {
        if (isObject(layer)) walkSteps(layer.steps, take(layerKey));
    }
    return found;
}

/**
 * Findings for the knowledge bases a routine's steps name.
 *
 * @param {object} definition
 * @param {object} p
 * @param {string} p.orgId        the routine's organisation (null for a personal routine)
 * @param {string} p.userId       the routine's owner
 * @param {'draft'|'activate'} p.stage
 * @param {object} [p.deps]
 * @returns {Promise<Array<{code,severity,path,message,hint}>>}
 */
async function kbStepFindings(definition, { orgId, userId, stage = 'draft', deps = {} } = /** @type {any} */ ({})) {
    const steps = collectKbSteps(definition);
    if (!steps.length) return [];

    const kbStore = deps.kbStore || require('../../stores/knowledgeBases');
    const severity = stage === 'activate' ? 'error' : 'warning';
    const findings = [];
    const cache = new Map();
    const writeCache = new Map();

    for (const step of steps) {
        if (step.access === 'write') {
            const kbId = step.kbIds[0];
            if (!writeCache.has(kbId)) {
                const { canOwnerWriteToKb } = deps.writeAccess || require('./kbWriteAccess');
                let verdict = { ok: false, reason: 'unknown' };
                try { verdict = await canOwnerWriteToKb(kbId, userId, { deps }); } catch (_) { /* refuse */ }
                writeCache.set(kbId, verdict);
            }
            const verdict = writeCache.get(kbId);
            if (!verdict.ok) {
                // Naming the base is only safe when the owner can already see
                // it. `messageFor` makes that call — for a base in another
                // organisation it deliberately says nothing about which.
                const { messageFor } = deps.writeAccess || require('./kbWriteAccess');
                findings.push({
                    path: step.path,
                    severity,
                    code: 'knowledge_write.kb_not_manageable',
                    message: messageFor(verdict.reason, verdict.kb?.name || null),
                    hint: 'Pick a knowledge base you manage, or ask an administrator for the "manage knowledge" permission.',
                });
            }
            continue;
        }

        for (const kbId of step.kbIds) {
            if (!cache.has(kbId)) {
                let kb = null;
                try { kb = await kbStore.getKB(kbId); } catch (_) { kb = null; }
                cache.set(kbId, kb);
            }
            const kb = cache.get(kbId);
            const base = { path: step.path, severity };

            if (!kb) {
                findings.push({
                    ...base,
                    code: 'kb.not_found',
                    message: `This step uses a knowledge base that no longer exists (${kbId}).`,
                    hint: 'Open the step and pick a knowledge base, or remove the grounding.',
                });
                continue;
            }

            const isSystem = typeof kbStore.isSystemKB === 'function' ? kbStore.isSystemKB(kb) : false;
            const ownedByOwner = kb.tenant_id === userId;
            const sameOrg = !!(kb.organization_id && orgId && kb.organization_id === orgId);
            if (!isSystem && !ownedByOwner && !sameOrg) {
                // The runtime refuses this one too. Naming which base it was is
                // safe: the author put the id in the definition themselves.
                findings.push({
                    ...base,
                    code: 'kb.cross_org',
                    message: `"${kb.name || kbId}" belongs to another organisation and cannot be used here.`,
                    hint: 'Pick a knowledge base from this organisation.',
                });
                continue;
            }

            // A system base has no owner to have expressed a preference.
            if (!isSystem && !kbUsableIn(kb, 'ai_step')) {
                findings.push({
                    ...base,
                    code: 'kb.context_missing',
                    message: `"${kb.name || kbId}" is not available to routines.`,
                    hint: 'In Knowledge → this base → Settings, tick "Routines" under where it can be used.',
                });
            }
        }
    }
    return findings;
}

module.exports = { kbStepFindings, collectKbSteps };
