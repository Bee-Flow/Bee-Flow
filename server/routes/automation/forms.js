/** @typedef {import('express-serve-static-core').Router} Router */
// The Forms directory and the Form page, split out of routes/automation/crud.js:
// the org's published forms, one form, who may fill it in, and its answers
// table. crud.js registers these routes on its own router, at the place they
// always had (before `/:id`).
const log = require('../../telemetry/log');
const { resolveDatatablePrincipal } = require('../../auth/datatableAccess');
const { ensureAnswersTable } = require('../../automation/liveSideEffects');
const automationStore = require('../../stores/automationStore');
const { validate } = require('../../core/http/validate');
const { syncDatatableUsage } = require('../../automation/datatableUsageSync');
const { audienceAdmits, needsGroups, publicAudience } = require('../../automation/formAudience');
const { AudienceBody, readAudienceBody } = require('./formAudienceBody');
const { roleSatisfies } = require('../../automation/access');
const { orgOf, automationAccess } = require('./crudContext');
const { registerFormTestLinkRoutes, editorFormFacts } = require('./formTestLink');

/**
 * `row → may this caller fill it in`, for a batch of page rows: the
 * caller's group memberships are read once, and only when some restricted
 * row names a group. The rows are org-scoped already (listFormPagesForOrg),
 * so the audience's organisation is the caller's own; an orgless caller only
 * ever sees their own rows, which the owner rule admits.
 */
async function admitsFor(rows, /** @type {import('express').Request} */ req) {
    const caller = { id: req.session.user.id, organizationId: (await orgOf(req)) || null };
    const audienceOf = (row) => ({
        userId: row.userId, organizationId: caller.organizationId,
        audience: row.audience, sharedGroups: row.sharedGroups, sharedUserIds: row.sharedUserIds,
    });
    let groups = [];
    if (rows.some(row => needsGroups(audienceOf(row), caller) && !audienceAdmits(audienceOf(row), caller, []))) {
        try {
            groups = await require('../../auth/audience').resolveUserGroups(caller.id);
        } catch (e) {
            log.warn('[automation forms list] group lookup failed:', /** @type {Error} */ (e).message);
        }
    }
    return (row) => audienceAdmits(audienceOf(row), caller, groups);
}

/**
 * The answers tables behind a directory of form automations, with the CALLER's
 * grade on each: form owner, org admin, or anyone the table is shared with.
 * One store round trip for the tables, one for the grants — never a probe
 * per row. A table the caller has no grade on stays anonymous (no id).
 */
async function answersInfoFor(automationIds, /** @type {import('express').Request} */ req) {
    const out = new Map();
    const ids = [...new Set(automationIds.filter(Boolean))];
    if (!ids.length) return out;
    try {
        const datatableStore = require('../../stores/datatableStore');
        const { gradeForPrincipal } = require('../../auth/datatableAccess');
        const principal = await resolveDatatablePrincipal(req);
        const tables = await datatableStore.listAnswersTablesForAutomations(ids);
        const grants = await datatableStore.listGrantsForTables(tables.map(t => t.id));
        for (const t of tables) {
            const prev = out.get(t.source.automationId);
            // the linked table wins; else the newest
            if (prev && prev.table.source.linked !== false && t.source.linked === false) continue;
            const grade = gradeForPrincipal(t, grants.get(t.id) || [], principal);
            out.set(t.source.automationId, { table: t, grade });
        }
    } catch (e) {
        log.warn('[automation forms list] answers lookup failed:', /** @type {Error} */ (e).message);
    }
    return out;
}

/** The `answers` block of one directory row. */
function answersFor(row, trigger, answersByAutomation) {
    const collecting = trigger?.form?.collect === true;
    const hit = answersByAutomation.get(row.automationId) || null;
    if (!hit && !collecting) return null;
    if (!hit) return { collecting, datatableId: null, grade: null, rowCount: null, linked: false, lastWriteError: null };
    const { table, grade } = hit;
    if (!grade) return { collecting, datatableId: null, grade: null, rowCount: null, linked: table.source.linked !== false, lastWriteError: null };
    return {
        collecting,
        datatableId: table.id,
        grade,
        rowCount: table.rowCount ?? null,
        linked: table.source.linked !== false,
        lastWriteError: table.source.lastWriteError || null,
    };
}

/**
 * @param {Router} router
 */
function registerFormRoutes(router) {
    /**
     * GET /forms — every published form in the caller's organisation.
     *
     * Registered before `/:id` like the folder and template routes; the route-table
     * test guards the ordering.
     *
     * Org-scoped on purpose (agreed with the owner): a published form has a public
     * URL, which makes it the organisation's, not its author's. The list is what
     * the Forms menu and the All-forms page are built on, and since the builder no
     * longer shows the public link, this is now the only place to get it.
     *
     * A page row outlives its trigger — the author can switch the trigger to
     * something else and the row stays so the old address can be reinstated — so
     * rows whose trigger is no longer a form are dropped here, exactly as
     * formPublic.js's loadForm drops them.
     */
    router.get('/forms', async (req, res) => {
        const rows = await automationStore.listFormPagesForOrg(await orgOf(req), req.session.user.id);
        // One entry per form, not per row. The old builder panel looked its
        // page up by trigger and created one when the lookup missed, which on
        // a multi-trigger automation could mint a SECOND page for the same form —
        // there are such pairs in the wild. Both addresses still work; showing
        // both just gives you the same form twice under one name. The busiest
        // wins, because that is the link people actually have (ties go to the
        // newest, which is the order the store returns).
        const byForm = new Map();
        for (const row of rows) {
            const key = `${row.automationId}::${row.triggerStepId || ''}`;
            const held = byForm.get(key);
            if (!held || row.submissions > held.submissions) byForm.set(key, row);
        }
        const forms = [];
        const answersByAutomation = await answersInfoFor([...byForm.values()].map(r => r.automationId), req);
        const admits = await admitsFor([...byForm.values()], req);
        for (const row of byForm.values()) {
            // What visitors are served: the live copy when there is one.
            const def = row.liveDefinition || row.definition || {};
            const trigger = row.triggerStepId
                ? [def.trigger, ...(def.triggers || [])].find(t => t?.id === row.triggerStepId)
                : def.trigger;
            if (trigger?.kind !== 'form') continue;
            const mine = row.userId === req.session.user.id;
            forms.push({
                id: row.id,
                url: `/f/${row.id}`,
                automationId: row.automationId,
                triggerStepId: row.triggerStepId,
                // The form's own heading when the author gave it one; the
                // automation's title is the fallback, which is what the builder
                // shows anyway.
                title: trigger.form?.title || row.title || 'Untitled form',
                description: trigger.form?.description || row.description || null,
                // A visitor gets a 404 unless BOTH are right, so this is the
                // difference between a link that works and one that does not.
                live: row.isActive && !row.isDraft,
                submissions: row.submissions,
                lastSeenAt: row.lastSeenAt,
                createdAt: row.createdAt,
                // Whether this caller can open the automation behind the form:
                // the automation endpoints are still per-user.
                mine,
                // Whether this caller may FILL IT IN — the visitor gate's own
                // rule (automation/formAudience), so /app/forms lists exactly
                // the forms that open. The list of who else may is the
                // owner's to see.
                canOpen: admits(row),
                audience: publicAudience(row, { owner: mine }),
                // The answers table and THIS caller's grade on it — what
                // decides whether the Answers dashboard is theirs to open.
                answers: answersFor(row, trigger, answersByAutomation),
            });
        }
        res.json({ forms });
    });

    // "Build it with AI": draft or revise a form's questions from a brief.
    // Lazy for the reason routes/skills.js gives for its `ai()`: the DB-free
    // suites of this router stub its dependencies by parent, and an eager
    // require would pull the LLM client and the provider adapters into them.
    // Literal path, so it sits above `/forms/:automationId` like the rest.
    const formsAi = () => require('./formsAi');
    router.post('/forms/ai/draft',
        (req, res, next) => formsAi().limiter(req, res, next),
        // Lazily, like everything else that reaches into formsAi from here: the
        // schema lives beside the handler that reads it.
        (req, res, next) => validate({ body: formsAi().DraftBody })(req, res, next),
        (req, res) => formsAi().draft(req, res));

    /**
     * GET /forms/:automationId — one form, for the Form page.
     *
     * Same audience as the directory (the organisation that owns it; 404
     * outside it, exactly like the visitor page). The DEFINITION travels only
     * to the owner — it is what the Questions and Settings tabs save through
     * PUT /:id, and a colleague who may read the answers may not read the
     * automation. Registered before `/:id` like GET /forms.
     */
    router.get('/forms/:automationId', async (req, res) => {
        const rows = await automationStore.listFormPagesForOrg(await orgOf(req), req.session.user.id);
        const mine = rows.filter(r => r.automationId === req.params.automationId);
        if (!mine.length) return res.status(404).json({ error: 'Not found' });
        // the primary trigger's page, busiest first, like the directory
        const row = mine.filter(r => !r.triggerStepId).sort((a, b) => (b.submissions || 0) - (a.submissions || 0))[0] || mine[0];
        const isOwner = row.userId === req.session.user.id;
        // Who may edit the questions (handoff 5): the owner, an org admin, or a
        // colleague with an `edit` share. Only they get the definition.
        const formAccess = isOwner ? { role: 'owner', via: 'owner' } : await automationAccess.roleFor(
            { id: row.automationId, userId: row.userId, organizationId: row.organizationId || null },
            req.session.user.id, { session: req.session });
        const mayEdit = roleSatisfies(formAccess.role, 'edit');
        // An editor edits the WORKING copy (saved back through PUT /:id); anyone
        // else reads the questions visitors are served, the live copy when there
        // is one (handoff 5), like the directory above.
        const def = (mayEdit ? row.definition : (row.liveDefinition || row.definition)) || {};
        const trigger = def.trigger;
        if (trigger?.kind !== 'form') return res.status(404).json({ error: 'Not found' });
        const answersByAutomation = await answersInfoFor([row.automationId], req);
        const admits = await admitsFor([row], req);
        const { normalizeFields } = require('../../automation/formTriggerContract');
        const formAnswers = require('../../automation/formAnswers');
        const form = {
            id: row.id,
            url: `/f/${row.id}`,
            automationId: row.automationId,
            triggerStepId: null,
            title: trigger.form?.title || row.title || 'Untitled form',
            description: trigger.form?.description || row.description || null,
            live: row.isActive && !row.isDraft,
            isActive: !!row.isActive,
            isDraft: !!row.isDraft,
            submissions: row.submissions,
            lastSeenAt: row.lastSeenAt,
            createdAt: row.createdAt,
            mine: isOwner,
            canOpen: admits(row),
            audience: publicAudience(row, { owner: isOwner }),
            questions: {
                title: trigger.form?.title || '',
                description: trigger.form?.description || '',
                submitLabel: trigger.form?.submitLabel || '',
                successMessage: trigger.form?.successMessage || '',
                collect: trigger.form?.collect === true,
                fields: normalizeFields(trigger.form),
                theme: trigger.form?.theme || null,
            },
            pages: formAnswers.inputPagesOf(def).map(p => ({ stepId: p.stepId, label: p.label, mode: 'input', fields: normalizeFields(p.form) })),
            answers: answersFor(row, trigger, answersByAutomation),
            myRole: formAccess.role,
            // An editor also learns what is not live yet (studio F11: pendingChanges,
            // liveVersion, version for Publish) and the form's test link.
            ...(mayEdit ? { definition: def, automationTitle: row.title || '', ...(await editorFormFacts(row.automationId)) } : {}),
        };
        res.json({ form });
    });

    /**
     * PUT /forms/:automationId/audience — who may fill the form in. Owner only.
     * Body `{ audience: 'org'|'restricted', sharedGroups: [groupId], sharedUserIds: [userId] }`,
     * validated against the caller's organisation (a group that is not the
     * org's, or a person outside it, is a 400 — never dropped). Written on the
     * PRIMARY trigger's page row; a rotated link keeps it (the store carries the
     * audience over). Answers with the owner's view of the audience.
     */
    router.put('/forms/:automationId/audience', validate({ body: AudienceBody }), async (/** @type {import('express').Request<{ automationId: string }, any, import('zod').infer<typeof AudienceBody>, import('qs').ParsedQs>} */ req, res) => {
        const a = await automationStore.getAutomation(req.params.automationId);
        if (!a) return res.status(404).json({ error: 'Not found' });
        if (!await automationAccess.guard(req, res, a, 'edit')) return;
        if (a.definition?.trigger?.kind !== 'form') return res.status(404).json({ error: 'Not found' });
        let wanted;
        try {
            wanted = await readAudienceBody(req.body, a.organizationId || (await orgOf(req)));
        } catch (err) {
            return res.status(err.status || 400).json({ error: /** @type {Error} */ (err).message, code: err.code || 'audience_invalid' });
        }
        // the primary trigger's page — made if a save never minted one
        const page = await automationStore.ensureFormPage(a.id, null);
        const updated = await automationStore.setFormPageAudience(page.id, a.id, wanted);
        if (!updated) return res.status(404).json({ error: 'Not found' });
        res.json({ audience: publicAudience(updated, { owner: true }) });
    });

    // The test link: GET/POST/DELETE /forms/:automationId/test-link and its audience (formTestLink.js).
    registerFormTestLinkRoutes(router);

    /**
     * POST /forms/:automationId/answers-table — make (or re-make) the answers
     * table for a form that collects. Owner only. Exists for "provisioning
     * failed, try again" and for a form whose table was deleted by hand.
     */
    router.post('/forms/:automationId/answers-table', async (req, res) => {
        const a = await automationStore.getAutomation(req.params.automationId);
        if (!a) return res.status(404).json({ error: 'Not found' });
        if (!await automationAccess.guard(req, res, a, 'edit')) return;
        const formAnswers = require('../../automation/formAnswers');
        if (!formAnswers.collectEnabled(a.definition)) {
            return res.status(409).json({ error: 'This form does not collect its answers in a table — switch that on first', code: 'collect_disabled' });
        }
        const { answers, usage } = await ensureAnswersTable(a, a.definition);
        if (answers?.error?.code === 'quota_exceeded') return res.status(409).json({ error: answers.error.message, code: 'quota_exceeded' });
        // The org comes from orgOf, as at every other call site: the usage
        // INSERT has a WHERE EXISTS on the org, so an automation from before
        // organization_id was stored (NULL) indexed nothing — and said nothing.
        await syncDatatableUsage(a.id, await orgOf(req), a.definition, { label: 'answers table', extraEntries: usage });
        res.json({ answers });
    });
}

module.exports = { registerFormRoutes };
