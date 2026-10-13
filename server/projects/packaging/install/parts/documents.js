/**
 * Install the DOCUMENT TEMPLATES, and the fields a template is written with.
 */

'use strict';

const { clone } = require('../refs');
const { writeOpts } = require('../context');

/** The fields a template is written with (camelCase), from its manifest entry. */
function templateFieldsOf(entity) {
    return {
        name: String(entity.name || 'Untitled document'),
        docType: typeof entity.doc_type === 'string' && entity.doc_type ? entity.doc_type : 'document',
        kind: ['template', 'section', 'document'].includes(entity.kind) ? entity.kind : 'template',
        description: typeof entity.description === 'string' ? entity.description : '',
        bodyHtml: typeof entity.body_html === 'string' ? entity.body_html : '',
        css: typeof entity.css === 'string' ? entity.css : '',
        settings: entity.settings && typeof entity.settings === 'object' && !Array.isArray(entity.settings) ? clone(entity.settings) : {},
    };
}

/**
 * Install the DOCUMENT TEMPLATES.
 *
 * A template is a document row owned by the installer, private and filed into
 * the Solution through `solution_project_id` (the membership registry's
 * `document_template` kind), never as project content. The revision a
 * `fill_document` step is pinned to is recorded in `ctx.templateVersions`
 * (template id → revision id): `patchReferences` and `resolveRefs` write it
 * onto the automations.
 *
 * Gallery path: `createDocument`, then filed through the registry. Stage path
 * (`ctx.managedWrite`): the template must exist in the stage before automations
 * resolve against it, so it is written with the deployment's capability by
 * `writeManagedTemplate` (one transaction, owned by the run-as user, filed at
 * INSERT) and the revision it wrote is the pin. A later release's content
 * reaches an existing template through `createVersionRow`, which the stage
 * engine calls itself and records in `ctx.templateVersions`.
 */
async function installDocumentTemplates(entities, ctx, report) {
    if (!entities.length) return;
    const staged = !!ctx.managedWrite;
    for (const entity of entities) {
        try {
            const fields = templateFieldsOf(entity);
            if (fields.docType === 'page') {
                report.skipped.push({ ref: entity.ref, kind: 'document', why: 'A page is never a Solution template.', permanent: true });
                continue;
            }
            let id;
            let versionId;
            if (staged) {
                const withTransaction = ctx.deps?.withTransaction || require('../../../../db').withTransaction;
                const out = await withTransaction((client) => require('../../../../stores/document/solutionTemplates').writeManagedTemplate(
                    client,
                    { ownerId: ctx.ownerId, orgId: ctx.organizationId || null, projectId: ctx.projectId, fields },
                    { managedWrite: ctx.managedWrite },
                ));
                ({ id, versionId } = out);
            } else {
                const created = await require('../../../../stores/documentStore').createDocument({
                    userId: ctx.ownerId, visibility: 'private', ...fields,
                });
                id = created.id;
                versionId = created.versionId;
                const filed = await require('../../../membership').getKind('document_template')
                    .setProject(id, ctx.ownerId, ctx.projectId, { projectId: ctx.projectId, req: ctx.req, ...writeOpts(ctx) });
                if (!filed) report.warnings.push(`The template "${entity.name}" was created but could not be filed into the Solution. Add it to the project by hand.`);
            }
            ctx.refMap.set(entity.ref, id);
            if (versionId) ctx.templateVersions.set(id, versionId);
            await ctx.stamp({ ref: entity.ref, kind: 'document', entityId: id, payload: fields });
            (report.installed.documents ||= []).push({ ref: entity.ref, id, name: entity.name, ...(versionId ? { versionId } : {}) });
        } catch (err) {
            report.skipped.push({ ref: entity.ref, kind: 'document', why: err.message });
        }
    }
}

module.exports = { templateFieldsOf, installDocumentTemplates };
