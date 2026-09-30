/**
 * What the access phase SAYS — a port of the web's stages/accessView.js
 * (where the app stands, what a role means, every change Approve would make,
 * why Approve is grey), pinned by accessView.lockstep.test.ts: both run on
 * the same plans with a `t` that echoes its English.
 */

import type { TranslateFn } from '@/core/i18n';

import type { AccessPlan, AppAccess } from './types';

type Named = { id: string; name?: string | null };
type Role = { key: string; label?: string | null; scope?: Record<string, string> | null };
type Rule = { roleKey: string; expr: string };

export interface AccessNow {
    published: boolean;
    tone: 'private' | 'groups' | 'open';
    who: string;
    named: number;
    namedLine: string;
}

/** Where the app stands right now, before anything here is applied. `named` counts its members. */
export function currentAccess(app: Pick<AppAccess, 'isPublished' | 'sharedGroups'> | null, named: number, t: TranslateFn): AccessNow {
    const published = !!app?.isPublished;
    const groups = app?.sharedGroups ?? [];
    const who = !published
        ? t('playbooks.access.now_private', 'Only you can open it')
        : groups.length
            ? groups.length === 1
                ? t('playbooks.access.now_groups_one', '1 group can open it')
                : t('playbooks.access.now_groups', '{n} groups can open it', { n: groups.length })
            : t('playbooks.access.now_org', 'Everyone in the organisation can open it');
    const namedLine = named
        ? named === 1
            ? t('playbooks.access.now_named_one', '1 person holds a named role')
            : t('playbooks.access.now_named', '{n} people hold a named role', { n: named })
        : t('playbooks.access.now_nobody', 'Nobody holds a named role yet');
    return { published, tone: !published ? 'private' : groups.length ? 'groups' : 'open', who, named, namedLine };
}

/** `record.supplier == "ACME"` as a sentence; anything else stays as it is. */
export function ruleWords(expr: string | null | undefined, t: TranslateFn): string {
    const m = /^record\.([A-Za-z][A-Za-z0-9_]*)\s*==\s*"(.*)"$/.exec(String(expr || '').trim());
    if (!m) return String(expr || '');
    return t('playbooks.access.role_scope', 'sees only rows where {column} is {value}', { column: m[1] as string, value: m[2] as string });
}

/** What a role means, in one line. */
export function roleWords(roleKey: string | null, ctx: { roles?: readonly Role[]; planRoles?: readonly Role[]; planRules?: readonly Rule[] }, t: TranslateFn): string {
    if (!roleKey) return t('playbooks.access.role_none_words', 'No access');
    if (roleKey === 'app') return t('playbooks.access.role_app', 'Can use the app');
    if (roleKey === 'member') return t('playbooks.access.role_member', 'Member');
    const proposed = (ctx.planRoles ?? []).find((r) => r.key === roleKey);
    if (proposed?.scope) return t('playbooks.access.role_scope', 'sees only rows where {column} is {value}', proposed.scope);
    const rule = (ctx.planRules ?? []).find((r) => r.roleKey === roleKey);
    if (rule?.expr) return ruleWords(rule.expr, t);
    const known = (ctx.roles ?? []).find((r) => r.key === roleKey);
    return known?.label || roleKey;
}

export interface PlannedChange {
    kind: 'audience' | 'role' | 'group' | 'member' | 'nc' | 'note';
    words: string;
}

function audienceChange(plan: AccessPlan, groups: readonly Named[], t: TranslateFn): PlannedChange | null {
    const a = plan.audience;
    if (!a) return null;
    if (a.kind === 'private') return { kind: 'audience', words: t('playbooks.access.change_private', 'Take the app off sharing — only you can open it.') };
    if (a.kind === 'organisation') return { kind: 'audience', words: t('playbooks.access.change_org', 'Publish it to everyone in the organisation.') };
    if (a.kind === 'groups' && a.groupIds.length) {
        const names = a.groupNames.length ? a.groupNames : a.groupIds.map((id) => groups.find((g) => g.id === id)?.name || id);
        return { kind: 'audience', words: t('playbooks.access.change_groups', 'Publish it to {names}.', { names: names.join(', ') }) };
    }
    return null;
}

type ChangeCtx = { groups?: readonly Named[]; users?: readonly Named[]; app?: unknown; roles?: readonly Role[] };

function roleChanges(plan: AccessPlan, t: TranslateFn): PlannedChange[] {
    return plan.roles.map((r) => {
        const rule = plan.tableRules.find((x) => x.roleKey === r.key);
        return {
            kind: 'role',
            words: rule
                ? t('playbooks.access.change_role_scoped', 'Create the role "{label}", which {what}.', { label: r.label, what: ruleWords(rule.expr, t) })
                : t('playbooks.access.change_role', 'Create the role "{label}".', { label: r.label }),
        };
    });
}

function peopleChanges(plan: AccessPlan, ctx: ChangeCtx, t: TranslateFn): PlannedChange[] {
    const naming = { roles: ctx.roles ?? [], planRoles: plan.roles, planRules: plan.tableRules };
    // A role KEY is an identifier; the sentence a person consents to names it.
    const roleName = (key: string) => plan.roles.find((r) => r.key === key)?.label
        || (ctx.roles ?? []).find((r) => r.key === key)?.label
        || roleWords(key, naming, t);
    const groups: PlannedChange[] = Object.entries(plan.byGroup).map(([groupId, roleKey]) => ({
        kind: 'group',
        words: t('playbooks.access.change_group_role', 'Give {group} the role "{role}".', { group: (ctx.groups ?? []).find((g) => g.id === groupId)?.name || groupId, role: roleName(roleKey) }),
    }));
    const members: PlannedChange[] = plan.members.map((m) => ({
        kind: 'member',
        words: t('playbooks.access.change_member', 'Give {name} the role "{role}".', { name: m.name || (ctx.users ?? []).find((u) => u.id === m.userId)?.name || m.userId, role: roleName(m.roleKey) }),
    }));
    return [...groups, ...members];
}

/** Every change Approve would make, one sentence each. */
export function plannedChanges(plan: AccessPlan, ctx: ChangeCtx, t: TranslateFn): PlannedChange[] {
    const audience = audienceChange(plan, ctx.groups ?? [], t);
    const out: PlannedChange[] = [...(audience ? [audience] : []), ...roleChanges(plan, t), ...peopleChanges(plan, ctx, t)];
    // Publishing takes a copy — a fact about the button, not a choice.
    if (plan.audience && plan.audience.kind !== 'private' && ctx.app) {
        out.push({ kind: 'note', words: t('playbooks.access.change_copy', 'Publishing takes a copy of the app exactly as it stands now.') });
    }
    return out;
}

/** Why Approve is grey — a disabled button with no reason is a dead end. */
export function whyDisabled(plan: AccessPlan | null, t: TranslateFn): string | null {
    if (!plan || plan.empty) return t('playbooks.access.why_empty', 'Choose who can open the app, or say it in a sentence above.');
    const a = plan.audience;
    if (a && a.kind === 'groups' && !a.groupIds.length) return t('playbooks.access.why_no_group', 'Pick at least one group, or choose a different audience.');
    return null;
}

/** The sentences the "say it" box offers, so it is not a blank page. */
export const ASK_EXAMPLES = Object.freeze([
    { key: 'playbooks.access.eg_finance', en: 'Finance may look at it, nobody else.' },
    { key: 'playbooks.access.eg_scoped', en: 'A role per supplier — each one sees only their own rows.' },
    { key: 'playbooks.access.eg_me', en: 'Keep it to me for now.' },
]);
