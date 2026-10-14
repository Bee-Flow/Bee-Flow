/**
 * Install the SKILLS, and the fields a skill is written with.
 */

'use strict';

const { fromRefs, isRef } = require('../../../../core/packaging/pointers');
const { clone } = require('../refs');
const { writeOpts } = require('../context');
const crypto = require('crypto');

/**
 * The ids of a skill's `{ $ref }` list: only the refs, resolved. A bare id
 * names a row of the installation the file came from, so it is not a pointer
 * here and never survives; a ref with nothing behind it leaves the list and is
 * named in `unresolved`.
 */
function resolvedRefList(list, refMap, unresolved) {
    const holder = { knowledge_base_ids: (Array.isArray(list) ? list : []).filter(isRef) };
    const { unresolved: missed } = fromRefs('skill', holder, refMap);
    for (const m of missed) unresolved.push(m.ref);
    return holder.knowledge_base_ids;
}

/**
 * The fields a skill is written with (camelCase, as createSkill and
 * writeManagedSkill take them), from its manifest entry.
 *
 * Each body facet is sent once: the structured form when there is one (the
 * store regenerates the text from it), the text form otherwise (the store
 * parses it). Sending both would let an empty structured column blank a
 * written-out text. Links to a base or an automation travel as `$ref` and are
 * resolved against `refMap`; step references the same. `sharedGroups`,
 * `isShared` and `enabledIntegrations` are never taken from a file.
 *
 * @param {object} entity
 * @param {Map<string, string>} refMap
 * @param {string[]} [unresolved]  collects every `$ref` that had no target
 */
function skillFieldsOf(entity, refMap, unresolved = []) {
    const fields = {
        name: String(entity.name || 'Untitled skill'),
        description: typeof entity.description === 'string' ? entity.description : '',
        instructions: typeof entity.instructions === 'string' ? entity.instructions : '',
        icon: typeof entity.icon === 'string' && entity.icon ? entity.icon : undefined,
        dynamicActivation: entity.dynamic_activation === true,
        knowledgeBaseIds: resolvedRefList(entity.knowledge_base_ids, refMap, unresolved),
        allowedAutomationIds: resolvedRefList(entity.allowed_automation_ids, refMap, unresolved),
        automationId: resolvedRefList(isRef(entity.automation_id) ? [entity.automation_id] : [], refMap, unresolved)[0] || null,
    };
    const steps = (Array.isArray(entity.steps) ? entity.steps : []).map((step) => {
        if (!step || typeof step !== 'object' || !Array.isArray(step.refs)) return step;
        const refs = [];
        for (const r of step.refs) {
            if (!r || !isRef(r.id)) continue;                 // a bare id names another installation's row
            const real = refMap.get(r.id.$ref);
            if (typeof real === 'string') refs.push({ ...r, id: real });
            else unresolved.push(r.id.$ref);
        }
        return { ...step, refs };
    });
    for (const [structured, text, camel, value] of [
        ['steps', 'workflow', 'steps', steps],
        ['rules_v2', 'rules', 'rulesV2', entity.rules_v2],
        ['examples_v2', 'examples', 'examplesV2', entity.examples_v2],
    ]) {
        if (Array.isArray(value) && value.length) fields[camel] = clone(value);
        else if (typeof entity[text] === 'string' && entity[text].trim()) fields[text] = entity[text];
        else if (entity[structured] !== undefined && !Array.isArray(entity[structured])) fields[camel] = entity[structured];
    }
    if (entity.output_schema && typeof entity.output_schema === 'object') fields.outputSchema = clone(entity.output_schema);
    for (const k of Object.keys(fields)) if (fields[k] === undefined) delete fields[k];
    return fields;
}

/**
 * Install the SKILLS.
 *
 * Gallery path: the skill is created under the installer, unshared and with no
 * connected app switched on (`enabled_integrations` is a requirement, never a
 * grant), then filed through the membership registry's `setProject`, the one
 * way a skill enters a Solution.
 *
 * Stage path (`ctx.managedWrite`): a stage skill has no live copy and is
 * written in the deployment's commit by `skillStore.writeManagedSkill`, so
 * nothing is written here. The row is COMPUTED: an id is allocated now so
 * automations and agents can point at it, and `report.computed.skills` carries
 * `{ ref, id, fields }`, ready for the commit. `skillFieldsOf` recomputes the
 * fields once every part of the release has an id.
 */
async function installSkills(entities, ctx, report) {
    if (!entities.length) return;
    const skillStore = require('../../../../stores/skillStore');
    const staged = !!ctx.managedWrite;
    for (const entity of entities) {
        try {
            const unresolved = [];
            const fields = skillFieldsOf(entity, ctx.refMap, unresolved);
            if (!staged) {
                for (const ref of new Set(unresolved)) {
                    report.warnings.push(`A reference to "${ref}" in the skill "${entity.name}" could not be connected — whatever it pointed at was not installed.`);
                }
            }
            let id;
            if (staged) {
                id = crypto.randomUUID();
                report.computed = report.computed || {};
                (report.computed.skills = report.computed.skills || []).push({ ref: entity.ref, id, fields });
            } else {
                const created = await skillStore.createSkill({
                    ...fields, orgId: ctx.organizationId || null, userId: ctx.ownerId,
                    isShared: false, sharedGroups: [], enabledIntegrations: [],
                });
                id = created.id;
                const filed = await require('../../../membership').getKind('skill')
                    .setProject(id, ctx.ownerId, ctx.projectId, { projectId: ctx.projectId, req: ctx.req, ...writeOpts(ctx) });
                if (!filed) report.warnings.push(`The skill "${entity.name}" was created but could not be filed into the Solution. Add it to the project by hand.`);
            }
            ctx.refMap.set(entity.ref, id);
            await ctx.stamp({ ref: entity.ref, kind: 'skill', entityId: id, payload: fields });
            (report.installed.skills ||= []).push({ ref: entity.ref, id, name: entity.name });
        } catch (err) {
            report.skipped.push({ ref: entity.ref, kind: 'skill', why: err.message });
        }
    }
}

module.exports = { resolvedRefList, skillFieldsOf, installSkills };
