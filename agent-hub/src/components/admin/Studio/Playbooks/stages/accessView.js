/**
 * What the access phase SAYS — worked out from the app, the directory and the
 * plan on the table. Pure, so the wording can be pinned without a DOM.
 *
 * The screen used to be three flat cards of controls: a sentence box, a row of
 * audience pills, and a list of every person in the organisation each with a
 * bare "—" dropdown. It never said where the app stood, never said what a role
 * would actually let someone see, and the Approve button went grey with no
 * reason given. This module is the words that fix that.
 */

/** The roles every app has, whatever its model says. */
export const BUILTIN_ROLES = ['app', 'member'];

/** Where the app stands right now, before anything on this screen is applied. */
export function currentAccess(app, members = [], t) {
    const published = !!(app && app.isPublished);
    const groups = (app && Array.isArray(app.sharedGroups) ? app.sharedGroups : []);
    const named = (Array.isArray(members) ? members : []).length;
    const who = !published
        ? t('playbooks.access.now_private', 'Only you can open it')
        : groups.length
            ? (groups.length === 1
                ? t('playbooks.access.now_groups_one', '1 group can open it')
                : t('playbooks.access.now_groups', '{n} groups can open it', { n: groups.length }))
            : t('playbooks.access.now_org', 'Everyone in the organisation can open it');
    return {
        published,
        tone: !published ? 'private' : groups.length ? 'groups' : 'open',
        who,
        named,
        namedLine: named
            ? (named === 1
                ? t('playbooks.access.now_named_one', '1 person holds a named role')
                : t('playbooks.access.now_named', '{n} people hold a named role', { n: named }))
            : t('playbooks.access.now_nobody', 'Nobody holds a named role yet'),
    };
}

/**
 * What a role means, in one line.
 *
 * A role key on its own ("app", "approver") tells a person nothing, and a row
 * rule — the whole reason the per-supplier roles exist — was visible only on
 * the AI's proposal and nowhere else.
 */
export function roleWords(roleKey, { roles = [], planRoles = [], tables = [], planRules = [] }, t) {
    if (!roleKey) return t('playbooks.access.role_none_words', 'No access');
    if (roleKey === 'app') return t('playbooks.access.role_app', 'Can use the app');
    if (roleKey === 'member') return t('playbooks.access.role_member', 'Member');
    const proposed = planRoles.find((r) => r.key === roleKey);
    if (proposed && proposed.scope) {
        return t('playbooks.access.role_scope', 'sees only rows where {column} is {value}', proposed.scope);
    }
    // A rule already on the model, for a role that exists.
    const rule = planRules.find((r) => r.roleKey === roleKey)
        || tables.flatMap((tb) => Object.entries(((tb.access && tb.access.rowFilters) || {}))
            .map(([key, expr]) => ({ roleKey: key, expr })))
            .find((r) => r.roleKey === roleKey);
    if (rule && rule.expr) return ruleWords(rule.expr, t);
    const known = roles.find((r) => r.key === roleKey);
    return (known && known.label) || roleKey;
}

/** `record.supplier == "ACME"` as a sentence. Anything else stays as it is. */
export function ruleWords(expr, t) {
    const m = /^record\.([A-Za-z][A-Za-z0-9_]*)\s*==\s*"(.*)"$/.exec(String(expr || '').trim());
    if (!m) return String(expr || '');
    return t('playbooks.access.role_scope', 'sees only rows where {column} is {value}', { column: m[1], value: m[2] });
}

/** Every role that can be handed out, with what it means. */
export function roleOptions({ roles = [], planRoles = [] }, t) {
    const seen = new Set();
    const out = [{ key: 'app', label: t('playbooks.access.role_app', 'Can use the app') }];
    seen.add('app');
    for (const r of [...roles, ...planRoles]) {
        if (!r || !r.key || seen.has(r.key)) continue;
        seen.add(r.key);
        out.push({ key: r.key, label: r.label || r.key });
    }
    if (!seen.has('member')) out.push({ key: 'member', label: t('playbooks.access.role_member', 'Member') });
    return out;
}

/**
 * Every change Approve would make, one sentence each.
 *
 * The gate used to show a single run-on summary; this is the list a person
 * reads before they press a button that publishes an app and hands out access.
 */
export function plannedChanges(plan, { groups = [], users = [], app = null, roles = [] }, t) {
    const out = [];
    // A role KEY is an identifier ("supplier_acme"), not a word. The gate is the
    // sentence a person consents to, so it has to name the role the way the
    // screen above it does — the same call the people list already makes.
    const planRoles = (plan && plan.roles) || [];
    const planRules = (plan && plan.tableRules) || [];
    const naming = { roles, planRoles, tables: [], planRules };
    const roleName = (key) => {
        const proposed = planRoles.find((r) => r.key === key);
        if (proposed && proposed.label) return proposed.label;
        const known = roles.find((r) => r.key === key);
        return (known && known.label) || roleWords(key, naming, t);
    };
    const a = plan && plan.audience;
    if (a) {
        if (a.kind === 'private') out.push({ kind: 'audience', words: t('playbooks.access.change_private', 'Take the app off sharing — only you can open it.') });
        else if (a.kind === 'organisation') out.push({ kind: 'audience', words: t('playbooks.access.change_org', 'Publish it to everyone in the organisation.') });
        else if (a.kind === 'groups' && (a.groupIds || []).length) {
            const names = (a.groupNames && a.groupNames.length ? a.groupNames : (a.groupIds || []).map((id) => (groups.find((g) => g.id === id) || {}).name || id));
            out.push({ kind: 'audience', words: t('playbooks.access.change_groups', 'Publish it to {names}.', { names: names.join(', ') }) });
        }
    }
    for (const r of (plan && plan.roles) || []) {
        const rule = ((plan && plan.tableRules) || []).find((x) => x.roleKey === r.key);
        out.push({
            kind: 'role',
            words: rule
                ? t('playbooks.access.change_role_scoped', 'Create the role "{label}", which {what}.', { label: r.label, what: ruleWords(rule.expr, t) })
                : t('playbooks.access.change_role', 'Create the role "{label}".', { label: r.label }),
        });
    }
    for (const [groupId, roleKey] of Object.entries((plan && plan.byGroup) || {})) {
        const name = (groups.find((g) => g.id === groupId) || {}).name || groupId;
        out.push({ kind: 'group', words: t('playbooks.access.change_group_role', 'Give {group} the role "{role}".', { group: name, role: roleName(roleKey) }) });
    }
    for (const m of (plan && plan.members) || []) {
        const name = m.name || (users.find((u) => u.id === m.userId) || {}).name || m.userId;
        out.push({ kind: 'member', words: t('playbooks.access.change_member', 'Give {name} the role "{role}".', { name, role: roleName(m.roleKey) }) });
    }
    if (plan && plan.nextcloudMenu && a && a.kind !== 'private') {
        out.push({ kind: 'nc', words: t('playbooks.access.change_nc', 'Put the app in your Nextcloud app menu.') });
    }
    // Publishing takes a copy — a fact about the button, not a choice.
    if (a && a.kind !== 'private' && app) {
        out.push({ kind: 'note', words: t('playbooks.access.change_copy', 'Publishing takes a copy of the app exactly as it stands now.') });
    }
    return out;
}

/** Why Approve is grey. A disabled button with no reason is a dead end. */
export function whyDisabled(plan, t) {
    if (!plan || plan.empty) return t('playbooks.access.why_empty', 'Choose who can open the app, or say it in a sentence above.');
    const a = plan.audience;
    if (a && a.kind === 'groups' && !(a.groupIds || []).length) return t('playbooks.access.why_no_group', 'Pick at least one group, or choose a different audience.');
    return null;
}

/** The sentences the "say it" box offers, so the box is not a blank page. */
export const ASK_EXAMPLES = Object.freeze([
    { key: 'playbooks.access.eg_finance', en: 'Finance may look at it, nobody else.' },
    { key: 'playbooks.access.eg_scoped', en: 'A role per supplier — each one sees only their own rows.' },
    { key: 'playbooks.access.eg_me', en: 'Keep it to me for now.' },
]);

/** People worth showing without searching: the ones who already have a role. */
export function peopleToShow(users, { members = [], plan = null, query = '' }, limit = 8) {
    const list = Array.isArray(users) ? users : [];
    const q = String(query || '').trim().toLowerCase();
    const has = new Set([
        ...(Array.isArray(members) ? members : []).map((m) => m.userId),
        ...(((plan && plan.members) || []).map((m) => m.userId)),
    ]);
    if (q) {
        return list.filter((u) => `${u.name || ''} ${u.email || ''}`.toLowerCase().includes(q)).slice(0, 25);
    }
    const withRole = list.filter((u) => has.has(u.id));
    if (withRole.length) return withRole;
    return list.slice(0, limit);
}
