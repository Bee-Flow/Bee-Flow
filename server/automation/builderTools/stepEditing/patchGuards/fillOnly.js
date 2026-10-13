/**
 * builder_update_step — the fill-only fields of an ai_step (agentId) and a
 * knowledge_write (knowledgeBaseId): a blank one may be filled, a bound one
 * is not re-pointed by a patch. Moved verbatim out of applyUpdateStep
 * (stepEditing.js). The datatable twin is linkDatatablePatch (datatable.js).
 */

/** A refusal, or null. */
function fillOnlyRefusal(stepId, step, found, patch) {
    // FILL-ONLY, for the datatable reason and one of its own: which AGENT
    // does the thinking is the field both checks look at — validate/stepRules
    // at save and activate, aiStepAgent at run time — and a patch is the one
    // path that could move it without the step being rebuilt. Re-pointing a
    // step at somebody else's agent is not an edit: it changes whose knowledge
    // is read and whose tools run, which is precisely the act those checks
    // exist to see. FILLING a blank one stays allowed, because an imported
    // automation arrives with the id blanked and this is where it gets repaired.
    //
    // ── EXCEPT INSIDE A LOOP BODY, WHERE THE ADVICE WAS A DEAD END ──
    // `builder_replace_step` refuses a loop-body step outright ("patch it with
    // builder_update_step"), so for an ai_step in a loop the two refusals
    // pointed at each other and the agent could not be changed at all — only
    // by deleting the step and adding it again, which mints a new id and breaks
    // every downstream reference. The re-point is allowed there, and it is not
    // an unchecked one: `persistDraft` builds the agent catalog and hands it to
    // `validateDefinition` on EVERY builder save, so the permission check runs
    // on this path too. That is also what makes the sentence below true.
    if (step.type === 'ai_step' && 'agentId' in patch && found.kind !== 'loop'
        && typeof step.agentId === 'string' && step.agentId
        && String(patch.agentId || '').trim() !== step.agentId) {
        return { error: `Step "${stepId}" already runs on agent "${step.agentId}". Pointing a step at a different agent is not a patch — use builder_replace_step, so the permission check runs on it.` };
    }
    // FILL-ONLY, for the datatable reason and one of its own: which knowledge
    // base a step writes to is exactly what the save-time permission check
    // looks at, and a patch is the one path that could change it without the
    // step being rebuilt. An imported step arrives with the id blanked, so
    // FILLING one stays allowed.
    if (step.type === 'knowledge_write' && 'knowledgeBaseId' in patch
        && typeof step.knowledgeBaseId === 'string' && step.knowledgeBaseId
        && String(patch.knowledgeBaseId || '').trim() !== step.knowledgeBaseId) {
        return { error: `Step "${stepId}" already writes to knowledge base "${step.knowledgeBaseId}". Pointing a write at a different base is not a patch — use builder_replace_step, so the permission check runs on it.` };
    }
    return null;
}

module.exports = { fillOnlyRefusal };
