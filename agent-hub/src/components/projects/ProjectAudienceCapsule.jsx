import { Lock, Users } from 'lucide-react';
import React from 'react';
import { useTranslation } from '../../hooks/useTranslation';

/**
 * Who can reach this Solution — the PROJECT ladder, wearing the capsule's
 * clothes.
 *
 * ── Why this is not VisibilityCapsule ───────────────────────────────────────
 *
 * It looks exactly like the org publish capsule in every Studio header, and it
 * means something else. That resemblance is the whole risk, so both halves are
 * written down here.
 *
 * VisibilityCapsule answers "is this PUBLISHED to the organisation, and to
 * which groups" — `isPublished` + `sharedGroups`, with one hard rule burnt into
 * it: published with an EMPTY group list means the whole organisation can see
 * it (server/auth/audience.js canSeePublished). A project has no such pair. Its
 * audience is `project_shares`: a row per user or per group, each carrying
 * owner / editor / viewer. Feeding that into VisibilityCapsule would teach it a
 * third state its "[] means everyone" rule would then be wrong about — and a
 * capsule that is wrong about who can see something is the worst bug this
 * product has.
 *
 * So this component BORROWS the look (32px, radius 10, border-default, 12px
 * text, glyph in --text-secondary) and nothing else. It is read-only: sharing a
 * project happens on the project page, where the person being invited can be
 * named.
 *
 * ── "Entire organisation" is deliberately absent ────────────────────────────
 *
 * There is no org-wide project share. `POST /:id/share` accepts
 * `sharedWithType: 'user' | 'group'` and nothing else, and the role ladder
 * (auth/projectAccess.js → projectStore.getProjectRole) resolves a role from
 * exactly those two. Offering "Organisation" in this control would claim access
 * that no row grants and no gate honours — a screen making a promise it cannot
 * keep. Two states are true today and both are shown:
 *
 *   "Members only"   no group shares — named people, and the owner
 *   "Group Sales"    one or more group shares (named, or counted past one)
 *
 * When an org-wide project share exists, this is the file that gains a third
 * state, together with the ladder that would have to honour it.
 */

/**
 * The audience sentence, from the members payload.
 *
 * `null` in, `null` out: a members list that could not be loaded is UNKNOWN,
 * and unknown must not render as "Members only" — that is a narrower claim than
 * the truth might be, and this control's whole job is to be right about scope.
 */
export function describeProjectAudience(members, groupNames = null) {
    if (!Array.isArray(members)) return null;
    const groups = members.filter(m => m?.sharedWithType === 'group');
    const people = members.filter(m => m?.sharedWithType === 'user');
    return { groupIds: groups.map(g => g.sharedWithId), peopleCount: people.length, groupNames };
}

export default function ProjectAudienceCapsule({ members, groupNames = null, className = '' }) {
    const { t } = useTranslation();
    const audience = describeProjectAudience(members, groupNames);

    // Unknown shows nothing at all rather than the narrower of the two answers.
    if (!audience) return null;

    const { groupIds } = audience;
    const nameOf = (id) => (groupNames && (groupNames[id] || groupNames.get?.(id))) || null;

    let label;
    let Icon;
    if (groupIds.length === 0) {
        Icon = Lock;
        label = t('solutions.audience_members_only', 'Members only');
    } else if (groupIds.length === 1) {
        Icon = Users;
        const name = nameOf(groupIds[0]);
        label = name
            ? t('solutions.audience_group', 'Group {name}').replace('{name}', name)
            : t('solutions.audience_one_group', '1 group');
    } else {
        Icon = Users;
        label = t('solutions.audience_groups', '{count} groups').replace('{count}', String(groupIds.length));
    }

    return (
        <span
            data-testid="solution-audience-capsule"
            title={t('solutions.audience_hint', 'Who can reach this Solution. Change it on the project page.')}
            className={`inline-flex items-center gap-1.5 h-8 px-2.5 rounded-[10px] border text-[12px] whitespace-nowrap ${className}`.trim()}
            style={{
                borderColor: 'var(--border-default)',
                background: 'var(--bg-primary)',
                color: 'var(--text-secondary)',
            }}
        >
            <Icon className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--text-secondary)' }} aria-hidden="true" />
            {label}
        </span>
    );
}
