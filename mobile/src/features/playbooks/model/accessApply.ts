/**
 * Applying an approved access plan — the phone's share of the web's
 * stages/accessApply.js, pinned where it overlaps (publishBody,
 * accessSummary) by accessApply.lockstep.test.ts.
 *
 * NOTHING here decides anything: the person approved a plan and this turns it
 * into calls against the owner-only App Studio endpoints that already audit
 * those writes. People first, then who may open the app.
 *
 * What the phone does NOT apply: new roles, row rules, a default role or a
 * role per group. On the web those are one write of the app's WHOLE data
 * model (PUT /api/studio-apps/:id/schema), merged into the model the App
 * Studio editor holds. The phone does not hold that model, and writing it
 * back from a phone that only read part of it is how a column added on the
 * desktop a minute ago disappears. A plan that needs one is approved on the
 * web (`needsModelWrite`), and the screen says so.
 */

import type { TranslateFn } from '@/core/i18n';

import type { AccessPlan } from './types';

/** Does approving this plan need the app's data model rewritten? */
export function needsModelWrite(plan: AccessPlan): boolean {
    return plan.roles.length > 0 || !!plan.defaultRole || Object.keys(plan.byGroup).length > 0 || plan.tableRules.length > 0;
}

/** The audience write, or null when the plan says nothing about it. */
export function publishBody(plan: Pick<AccessPlan, 'audience'> | null): { isPublished: boolean; sharedGroups?: string[] } | null {
    const a = plan?.audience;
    if (!a) return null;
    if (a.kind === 'private') return { isPublished: false };
    if (a.kind === 'organisation') return { isPublished: true, sharedGroups: [] };
    if (a.kind === 'groups' && a.groupIds.length) return { isPublished: true, sharedGroups: a.groupIds };
    return null;
}

export interface AccessDeps {
    assignMember: (userId: string, roleKey: string) => Promise<unknown>;
    publish: (body: { isPublished: boolean; sharedGroups?: string[] }) => Promise<unknown>;
}

export interface ApplyOutcome {
    applied: string[];
    failed: { what: string; error: unknown }[];
}

/** People, then the audience. One failure never stops the rest. */
export async function applyAccessPlan(plan: AccessPlan, deps: AccessDeps): Promise<ApplyOutcome> {
    const applied: string[] = [];
    const failed: ApplyOutcome['failed'] = [];
    for (const m of plan.members) {
        try {
            await deps.assignMember(m.userId, m.roleKey);
            applied.push(`member:${m.userId}`);
        } catch (error) {
            failed.push({ what: `member:${m.name || m.userId}`, error });
        }
    }
    const body = publishBody(plan);
    if (body) {
        try {
            await deps.publish(body);
            applied.push('audience');
        } catch (error) {
            failed.push({ what: 'audience', error });
        }
    }
    return { applied, failed };
}

/** The one line the phase lands with (the web's accessSummary). */
export function accessSummary(plan: AccessPlan, t: TranslateFn): string {
    const kind = plan.audience?.kind;
    const who = kind === 'organisation'
        ? t('playbooks.access.sum_org', 'the whole organisation')
        : kind === 'groups'
            ? plan.audience?.groupNames.join(', ') ?? ''
            : kind === 'private'
                ? t('playbooks.access.sum_private', 'nobody but you')
                : null;
    const parts: string[] = [];
    if (who) parts.push(t('playbooks.access.sum_shared', 'Shared with {who}', { who }));
    if (plan.roles.length) parts.push(t('playbooks.access.sum_roles', '{n} new role(s)', { n: plan.roles.length }));
    if (plan.tableRules.length) parts.push(t('playbooks.access.sum_rules', '{n} of them see only their own rows', { n: plan.tableRules.length }));
    if (plan.members.length) parts.push(t('playbooks.access.sum_people', '{n} person/people given a role', { n: plan.members.length }));
    return parts.length ? `${parts.join(' · ')}.` : t('playbooks.access.sum_nothing', 'Nothing changed — the app stays yours alone.');
}
