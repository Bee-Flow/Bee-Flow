/**
 * Applying an approved access proposal — pure, so the order and the failure
 * behaviour are testable without a network.
 *
 * NOTHING here decides anything: the person approved a plan and this turns it
 * into the smallest set of calls against the owner-only endpoints that already
 * audit those writes. Roles first (a member cannot hold a role the model does
 * not have yet), then the people, then who may open the app at all.
 */

/**
 * The model tables, with each approved row rule written onto the table it
 * belongs to, under the role that carries it.
 *
 * It rides in the SAME model write as the roles — a rule saved a moment after
 * the role it belongs to is a window in which the role exists and sees
 * everything. `saveRowFilter` (one call per rule) would open exactly that
 * window, N times.
 */
export function mergedTables(current, plan) {
    const rules = Array.isArray(plan?.tableRules) ? plan.tableRules : [];
    const tables = Array.isArray(current) ? current : [];
    if (!rules.length) return tables;
    return tables.map((t) => {
        const mine = rules.filter((r) => r && r.tableId === t.id && r.roleKey && r.expr);
        if (!mine.length) return t;
        const access = (t.access && typeof t.access === 'object') ? t.access : {};
        const rowFilters = { ...(access.rowFilters || {}) };
        for (const r of mine) rowFilters[r.roleKey] = r.expr;
        return { ...t, access: { ...access, rowFilters } };
    });
}

/** The model a `saveRoles` write should carry, merging the plan into what is there. */
export function mergedRoles(current, plan) {
    const roles = Array.isArray(current) ? [...current] : [];
    for (const r of (plan?.roles || [])) {
        if (!roles.some((x) => x && x.key === r.key)) roles.push({ key: r.key, label: r.label });
    }
    return roles;
}

export function mergedMapping(current, plan) {
    const base = current && typeof current === 'object' ? current : { default: 'app', byGroup: {} };
    return {
        ...base,
        default: plan?.defaultRole || base.default || 'app',
        byGroup: { ...(base.byGroup || {}), ...(plan?.byGroup || {}) },
    };
}

/** The audience write, or null when the plan says nothing about it. */
export function publishBody(plan) {
    const a = plan && plan.audience;
    if (!a) return null;
    if (a.kind === 'private') return { isPublished: false };
    if (a.kind === 'organisation') return { isPublished: true, sharedGroups: [] };
    if (a.kind === 'groups' && Array.isArray(a.groupIds) && a.groupIds.length) return { isPublished: true, sharedGroups: a.groupIds };
    return null;
}

/**
 * What an approved plan changes, in the order it has to happen.
 * `deps`: { saveRoles(roles, mapping, tables?), assignMember(userId, roleKey),
 *           publish(body), setNextcloudMenu?(enabled) }
 * `current`: { roles, roleMapping, tables, nextcloudMenu } — what stands now.
 * Returns { applied: string[], failed: [{ what, error }], nc } — one failure
 * never stops the rest: a member who could not be added must not cost the
 * audience, and a Nextcloud that is not connected must not cost either.
 */
export async function applyAccessPlan(plan, { roles: currentRoles, roleMapping, tables: currentTables, nextcloudMenu = false }, deps) {
    const applied = [];
    const failed = [];
    const rules = Array.isArray(plan?.tableRules) ? plan.tableRules : [];
    const needsModel = (plan?.roles || []).length > 0 || !!plan?.defaultRole
        || Object.keys(plan?.byGroup || {}).length > 0 || rules.length > 0;
    if (needsModel) {
        try {
            await deps.saveRoles(
                mergedRoles(currentRoles, plan),
                mergedMapping(roleMapping, plan),
                rules.length ? mergedTables(currentTables, plan) : undefined,
            );
            applied.push('roles');
            if (rules.length) applied.push(`rules:${rules.length}`);
        } catch (e) {
            failed.push({ what: 'roles', error: e });
        }
    }
    for (const m of (plan?.members || [])) {
        try {
            await deps.assignMember(m.userId, m.roleKey);
            applied.push(`member:${m.userId}`);
        } catch (e) {
            failed.push({ what: `member:${m.name || m.userId}`, error: e });
        }
    }
    const body = publishBody(plan);
    let published = false;
    if (body) {
        try {
            await deps.publish(body);
            published = !!body.isPublished;
            applied.push('audience');
        } catch (e) {
            failed.push({ what: 'audience', error: e });
        }
    }
    // The Nextcloud app menu, LAST and only on a published app: the server
    // answers 409 not_published otherwise, which is why PublishModal orders it
    // the same way. Unchanged means no call at all.
    let nc = null;
    const wantMenu = !!plan?.nextcloudMenu;
    if (deps.setNextcloudMenu && published && wantMenu !== !!nextcloudMenu) {
        try {
            nc = await deps.setNextcloudMenu(wantMenu);
            applied.push(wantMenu ? 'nc_menu' : 'nc_menu_off');
        } catch (e) {
            failed.push({ what: 'nc_menu', error: e });
        }
    }
    return { applied, failed, nc };
}

/** The one line the phase lands with. */
export function accessSummary(plan, t) {
    const who = plan?.audience?.kind === 'organisation'
        ? t('playbooks.access.sum_org', 'the whole organisation')
        : plan?.audience?.kind === 'groups'
            ? (plan.audience.groupNames || []).join(', ')
            : plan?.audience?.kind === 'private'
                ? t('playbooks.access.sum_private', 'nobody but you')
                : null;
    const people = (plan?.members || []).length;
    const roles = (plan?.roles || []).length;
    const rules = (plan?.tableRules || []).length;
    const parts = [];
    if (who) parts.push(t('playbooks.access.sum_shared', 'Shared with {who}', { who }));
    if (plan?.nextcloudMenu && plan?.audience?.kind && plan.audience.kind !== 'private') parts.push(t('playbooks.access.sum_nc_menu', 'in the Nextcloud app menu'));
    if (roles) parts.push(t('playbooks.access.sum_roles', '{n} new role(s)', { n: roles }));
    if (rules) parts.push(t('playbooks.access.sum_rules', '{n} of them see only their own rows', { n: rules }));
    if (people) parts.push(t('playbooks.access.sum_people', '{n} person/people given a role', { n: people }));
    return parts.length ? `${parts.join(' · ')}.` : t('playbooks.access.sum_nothing', 'Nothing changed — the app stays yours alone.');
}
