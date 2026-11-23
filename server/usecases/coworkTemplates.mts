/**
 * Templates from your organisation (routes/coworkTemplateRoutes.js): a member saves a cowork as a template, and a
 * colleague of the same organisation starts from it.
 *
 * A template is safe to hand around:
 *
 *   - SAVING keeps the title, the brief and how often it repeats, and, when the item had an approved plan, that
 *     plan's definition as the export sanitiser leaves it (automation/portability.js buildExport, the same sweep a
 *     downloaded automation goes through: no connection, no credential, no approver, no captured test data). Never
 *     the item's runs, its trust, its shares or its start. Only the item's owner saves it, and only into their own
 *     organisation; a person without one saves nothing.
 *   - LOOKING recomputes what the plan may do from the stored definition (core/cowork/plan/planPermissions.mts) and
 *     runs the plan checks (core/cowork/plan/planChecks.mts) every time. Nothing a template carries about its own
 *     permissions is read: a list stored next to a plan could say less than the plan does.
 *   - ADDING makes a NEW item of the caller's, paused. Its plan, when the template has one without findings, becomes
 *     an automation of the caller's, inactive, named as the item's plan and NOT approved: the caller tries it out and
 *     approves it through the plan flow like any other (usecases/coworkPlan.mts). Adding runs nothing and approves
 *     nothing.
 *
 * A template of another organisation does not exist for the caller: 404, the same as an id nobody used.
 */

import { createRequire } from 'node:module';
import type { Definition, PlanFinding, PlanPermissions, PlanView, ToolLookups } from '../core/cowork/plan/planTypes.mts';
import type { CoworkTemplate, CoworkTemplateStore } from '../stores/coworkTemplates.mts';
import { checkPlan } from '../core/cowork/plan/planChecks.mts';
import { permissionsOf, planFingerprint, plainPlan } from '../core/cowork/plan/planPermissions.mts';
import { planViewOf } from '../core/cowork/plan/planView.mts';
import { toolLookups } from '../core/cowork/plan/planLookups.mts';

const nodeRequire = createRequire(import.meta.url);
const { HttpError } = nodeRequire('../core/http/errors.js') as { HttpError: new (status: number, code: string, message: string) => Error };

interface Item { id: string; userId: string; title?: string | null; prompt?: string | null; repeatInterval?: string | null; triggerKind?: string | null }
interface Person { id: string; organizationId?: string | null; status?: string | null; displayName?: string | null; username?: string | null }
interface NewItemFields { userId: string; title: string; prompt: string; repeatInterval: string | null; nextRunAt: string; triggerKind: 'schedule'; modelTier: string }
interface NewAutomation { userId: string; organizationId: string; title: string; description: string; definition: Record<string, unknown>; triggerType: string; versionMeta: { description: string; descriptionJson: unknown[] } }

export interface TemplateDeps {
    templates: Pick<CoworkTemplateStore, 'create' | 'listForOrg' | 'get' | 'remove'>;
    getUser: (id: string) => Promise<Person | null>;
    /** Does this person administer this organisation (auth/permissions.js evalOrgAdmin)? */
    isOrgAdmin: (userId: string, organizationId: string) => Promise<boolean>;
    getApprovedPlan: (scheduleId: string) => Promise<{ definition: unknown } | null>;
    /** The export sanitiser: the definition as it may leave its owner, and what it cleared. */
    clean: (definition: unknown) => { definition: Record<string, unknown>; warnings: string[] };
    lookups: ToolLookups;
    createSchedule: (fields: NewItemFields) => Promise<Item | null>;
    pauseSchedule: (id: string) => Promise<unknown>;
    deleteSchedule: (id: string) => Promise<unknown>;
    scheduleCount: (userId: string) => Promise<number>;
    maxItems: () => Promise<number>;
    createAutomation: (input: NewAutomation) => Promise<{ id: string } | null>;
    attachPlanAutomation: (scheduleId: string, automationId: string, opts: { onlyIfNone: boolean }) => Promise<unknown>;
    now: () => number;
}

const DEFAULT_MAX_ITEMS = 10; // the same ceiling as routes/cowork.js (config ai_tasks_max_per_user)
const DAY_MS = 86_400_000;

export function defaultDeps(): TemplateDeps {
    const users = () => nodeRequire('../stores/userStore.js') as { getUser: TemplateDeps['getUser']; getAllGroups: () => Promise<unknown[]> };
    const cowork = () => nodeRequire('../stores/coworkStore.js') as {
        createSchedule: TemplateDeps['createSchedule']; updateSchedule: (id: string, patch: { isActive: boolean }) => Promise<unknown>;
        deleteSchedule: TemplateDeps['deleteSchedule']; getScheduleCount: TemplateDeps['scheduleCount'];
        getApprovedPlan: TemplateDeps['getApprovedPlan']; attachPlanAutomation: TemplateDeps['attachPlanAutomation'];
    };
    return {
        templates: (nodeRequire('../stores/coworkTemplates.mts') as typeof import('../stores/coworkTemplates.mts')).coworkTemplates(),
        getUser: (id) => users().getUser(id),
        isOrgAdmin: async (userId, orgId) => {
            const { evalOrgAdmin } = nodeRequire('../auth/permissions.js') as { evalOrgAdmin: (user: unknown, groups: unknown[], orgId: string) => boolean };
            return evalOrgAdmin(await users().getUser(userId), (await users().getAllGroups()) ?? [], orgId);
        },
        getApprovedPlan: (id) => cowork().getApprovedPlan(id),
        clean: (definition) => {
            const { buildExport } = nodeRequire('../automation/portability.js') as { buildExport: (a: unknown) => { envelope: { automation: { definition: Record<string, unknown> } }; warnings: string[] } };
            const { envelope, warnings } = buildExport({ definition });
            return { definition: envelope.automation.definition, warnings };
        },
        lookups: toolLookups(),
        createSchedule: (fields) => cowork().createSchedule(fields),
        pauseSchedule: (id) => cowork().updateSchedule(id, { isActive: false }),
        deleteSchedule: (id) => cowork().deleteSchedule(id),
        scheduleCount: (userId) => cowork().getScheduleCount(userId),
        maxItems: async () => {
            const limit = await (nodeRequire('../stores/configStore.js') as { getConfig: (key: string) => Promise<unknown> }).getConfig('ai_tasks_max_per_user');
            return typeof limit === 'number' && limit > 0 ? limit : DEFAULT_MAX_ITEMS;
        },
        createAutomation: (input) => (nodeRequire('../stores/automationStore') as { createAutomation: TemplateDeps['createAutomation'] }).createAutomation(input),
        attachPlanAutomation: (scheduleId, automationId, opts) => cowork().attachPlanAutomation(scheduleId, automationId, opts),
        now: () => Date.now(),
    };
}

const refuse = (status: number, message: string) => new HttpError(status, 'cowork_template_refused', message);
const NOT_FOUND = 'That template does not exist.';

/** The caller's organisation; a person without one has no templates. */
async function orgOf(userId: string, deps: TemplateDeps): Promise<string | null> {
    const user = await deps.getUser(userId);
    return user?.organizationId ? String(user.organizationId) : null;
}

/** A template of the caller's organisation, else a 404. */
async function loadTemplate(userId: string, id: string, deps: TemplateDeps): Promise<{ orgId: string; template: CoworkTemplate }> {
    const orgId = await orgOf(userId, deps);
    const template = orgId ? await deps.templates.get(id, orgId) : null;
    if (!orgId || !template) throw refuse(404, NOT_FOUND);
    return { orgId, template };
}

/** What a template's plan is, worked out now from its definition alone. */
export interface TemplatePlan {
    view: PlanView;
    permissions: PlanPermissions;
    findings: PlanFinding[];
    /** Adding the template also adds this plan (unapproved): it has no findings. */
    attachable: boolean;
}

const CHANGED: PlanFinding = Object.freeze({ code: 'template.changed', stepId: null, message: 'This plan is not the one that was saved, so it is left out.' });

/** The plan of a template: what it may do and why it may not run, recomputed; null when it carries none. */
export function templatePlanOf(template: Pick<CoworkTemplate, 'definition' | 'fingerprint'>, lookups: ToolLookups): TemplatePlan | null {
    if (!template.definition) return null;
    const definition = template.definition as Definition;
    const findings = [...checkPlan(definition, lookups)];
    if (template.fingerprint !== planFingerprint(definition)) findings.push(CHANGED);
    return {
        view: planViewOf(definition, lookups),
        // Of the plain plan: layout says nothing about what a plan may do.
        permissions: permissionsOf(plainPlan(definition) as Definition, lookups),
        findings,
        attachable: findings.length === 0,
    };
}

export interface TemplateCard { id: string; title: string; brief: string; repeatInterval: string | null; hasPlan: boolean; createdAt: string | null; mine: boolean }

const cardOf = (t: CoworkTemplate, userId: string): TemplateCard => ({
    id: t.id, title: t.title, brief: t.brief, repeatInterval: t.repeatInterval, hasPlan: !!t.definition, createdAt: t.createdAt, mine: t.createdBy === userId,
});

/** Save the caller's item as a template of their organisation. */
export async function saveAsTemplate({ item, userId, title }: { item: Item; userId: string; title?: string | null }, deps: TemplateDeps = defaultDeps()): Promise<{ template: TemplateCard; warnings: string[] }> {
    if (item.userId !== userId) throw refuse(403, 'Only the owner of a cowork saves it as a template.');
    if (item.triggerKind === 'app_event') throw refuse(409, 'A cowork that starts on a new mail cannot be a template yet.');
    const orgId = await orgOf(userId, deps);
    if (!orgId) throw refuse(409, 'Templates are shared within an organisation, and your account has none.');
    const plan = await cleanedPlanOf(item.id, deps);
    const template = await deps.templates.create({
        organizationId: orgId,
        createdBy: userId,
        title: titleOf(title, item.title),
        brief: item.prompt ?? '',
        repeatInterval: item.repeatInterval ?? null,
        definition: plan.definition,
        fingerprint: plan.fingerprint,
    });
    return { template: cardOf(template, userId), warnings: plan.warnings };
}

const titleOf = (asked: string | null | undefined, item: string | null | undefined): string => (asked ?? '').trim() || (item ?? '').trim() || 'Cowork';

/** The item's approved plan as it may be handed around, with its fingerprint; all null without one. */
async function cleanedPlanOf(itemId: string, deps: TemplateDeps): Promise<{ definition: Record<string, unknown> | null; fingerprint: string | null; warnings: string[] }> {
    const approved = await deps.getApprovedPlan(itemId);
    if (!approved) return { definition: null, fingerprint: null, warnings: [] };
    const cleaned = deps.clean(approved.definition);
    return { definition: cleaned.definition, fingerprint: planFingerprint(cleaned.definition as Definition), warnings: cleaned.warnings };
}

/** The templates of the caller's organisation; none without one. */
export async function listTemplates(userId: string, deps: TemplateDeps = defaultDeps()): Promise<TemplateCard[]> {
    const orgId = await orgOf(userId, deps);
    if (!orgId) return [];
    return (await deps.templates.listForOrg(orgId)).map((t) => cardOf(t, userId));
}

export interface TemplateViewOut { template: TemplateCard & { savedBy: string | null; canDelete: boolean }; plan: TemplatePlan | null }

const nameOf = (p: Person | null): string | null => (p ? (p.displayName || p.username || '').trim() || null : null);

/** One template, as someone about to add it sees it: its brief, its schedule, and what its plan may do. */
export async function templateView(userId: string, id: string, deps: TemplateDeps = defaultDeps()): Promise<TemplateViewOut> {
    const { orgId, template } = await loadTemplate(userId, id, deps);
    const mine = template.createdBy === userId;
    const [savedBy, admin] = await Promise.all([
        template.createdBy ? deps.getUser(template.createdBy) : Promise.resolve(null),
        mine ? Promise.resolve(false) : deps.isOrgAdmin(userId, orgId),
    ]);
    return {
        template: { ...cardOf(template, userId), savedBy: nameOf(savedBy), canDelete: mine || admin },
        plan: templatePlanOf(template, deps.lookups),
    };
}

/** The new item's plan: an inactive automation of the caller's, named as the item's plan, not approved. */
async function attachTemplatePlan(itemId: string, userId: string, orgId: string, template: CoworkTemplate, deps: TemplateDeps): Promise<void> {
    const definition = structuredClone(template.definition) as Record<string, unknown>;
    const kind = (definition.trigger as { kind?: unknown } | null | undefined)?.kind;
    const automation = await deps.createAutomation({
        userId, organizationId: orgId, title: template.title, description: '', definition,
        triggerType: typeof kind === 'string' && kind ? kind : 'manual',
        versionMeta: {
            description: `Created from template "${template.title}"`,
            descriptionJson: [{ code: 'created_from_template', params: { template: template.title, templateId: template.id } }],
        },
    });
    if (!automation?.id) throw new Error('the plan of the template could not be stored');
    await deps.attachPlanAutomation(itemId, automation.id, { onlyIfNone: true });
}

export interface UsedTemplate { item: Item; planAttached: boolean; findings: PlanFinding[] }

/** Start a new item of the caller's from a template: paused, with its plan unapproved. Runs nothing. */
export async function useTemplate(userId: string, id: string, deps: TemplateDeps = defaultDeps()): Promise<UsedTemplate> {
    const { orgId, template } = await loadTemplate(userId, id, deps);
    return startFrom(userId, orgId, template, deps);
}

/**
 * A new, paused item of `userId` from a template's content (an org template, or a package file:
 * ./coworkPackages.mts). Its plan, when it has no findings, is attached unapproved. Runs nothing.
 */
export async function startFrom(userId: string, orgId: string, template: CoworkTemplate, deps: TemplateDeps = defaultDeps()): Promise<UsedTemplate> {
    const max = await deps.maxItems();
    if (await deps.scheduleCount(userId) >= max) throw refuse(400, `Maximum number of cowork schedules reached (${max}). Delete or pause one to create another.`);
    const plan = templatePlanOf(template, deps.lookups);
    // A day ahead, and paused straight away: nothing is due in between, and the owner chooses when it runs.
    const item = await deps.createSchedule({
        userId, title: template.title, prompt: template.brief, repeatInterval: template.repeatInterval,
        nextRunAt: new Date(deps.now() + DAY_MS).toISOString(), triggerKind: 'schedule', modelTier: 'fast',
    });
    if (!item) throw new Error('the cowork was not created');
    try {
        await deps.pauseSchedule(item.id);
        if (plan?.attachable) await attachTemplatePlan(item.id, userId, orgId, template, deps);
    } catch (err) {
        // No half-made item: one without its pause could run.
        await deps.deleteSchedule(item.id);
        throw err;
    }
    return { item: { ...item, isActive: false } as Item, planAttached: !!plan?.attachable, findings: plan?.findings ?? [] };
}

/** Delete a template: its creator, or someone who administers its organisation. */
export async function deleteTemplate(userId: string, id: string, deps: TemplateDeps = defaultDeps()): Promise<{ deleted: true }> {
    const { orgId, template } = await loadTemplate(userId, id, deps);
    const asAdmin = template.createdBy !== userId && await deps.isOrgAdmin(userId, orgId);
    if (template.createdBy !== userId && !asAdmin) throw refuse(403, 'Only the person who saved a template, or an administrator, deletes it.');
    if (!await deps.templates.remove(template.id, orgId, { userId, asAdmin })) throw refuse(404, NOT_FOUND);
    return { deleted: true };
}
