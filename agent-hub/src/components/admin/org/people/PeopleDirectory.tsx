import { Building2, Search, UserPlus, Users as UsersIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import { ORG_NONE, useUserFilters } from '@/hooks/useUserFilters';
import EmptyState from '@/components/shared/EmptyState';
import SegmentedControl from '@/components/shared/SegmentedControl';
import UserListSkeleton from '@/components/shared/UserListSkeleton';
import UserFilterBar from '../../shared/UserFilterBar';
import type { AdminGroup, AdminOrganization } from '../userManagement/types';
import { membershipFor } from './orgMembership';
import PeopleGroupSection from './PeopleGroupSection';
import type { PeopleUser } from './PeopleRow';
import { GROUP_BY, useUserDirectory } from './useUserDirectory';
import { AddButton, EntitySectionIntro } from '../userManagement/EntityRows';
import { nOf } from '@/utils/plural';

interface PeopleDirectoryProps {
    users?: PeopleUser[];
    groups?: AdminGroup[];
    organizations?: AdminOrganization[];
    loading?: boolean;
    canManageUsers?: boolean;
    /** The viewer is a platform admin, who alone manages a platform admin's account. */
    viewerIsPlatformAdmin?: boolean;
    /** The viewer's home organisation: the accounts anyone but a platform admin may act on. */
    viewerHomeOrgId?: string | null;
    /**
     * The organisation the admin dashboard narrowed the lists to. The people are
     * shown under that organisation only, counted as one, and the directory's
     * own organisation filter is left out: the dashboard bar is the one choice.
     * `organizations` stays the full list, for the names.
     */
    scopeOrgId?: string | null;
    onAddUser: () => void;
    onEditUser?: (user: PeopleUser) => void;
    onResetMfa?: (user: PeopleUser) => void;
    onDeleteUser?: (user: PeopleUser) => void;
    onApproveUser?: (user: PeopleUser) => void;
    onRejectUser?: (user: PeopleUser) => void;
}

/**
 * The directory's top line: the counts and "Add user". No heading: the admin
 * dashboard's page header and the Users tab already name it. The organisations
 * are counted only when there is more than one to tell apart.
 */
function PeopleHeader({ people, orgs, groups, singleOrg, canManageUsers, onAddUser }: {
    people: number; orgs: number; groups: number; singleOrg: boolean; canManageUsers: boolean; onAddUser: () => void;
}) {
    const { t } = useTranslation();
    const parts = [
        nOf(t, 'admin_people.summary_people', people, '{count} person', '{count} people'),
        singleOrg ? null : nOf(t, 'admin_people.summary_orgs', orgs, '{count} organisation', '{count} organisations'),
        nOf(t, 'admin_people.summary_groups', groups, '{count} group', '{count} groups'),
    ].filter(Boolean);
    return (
        <EntitySectionIntro
            description={<span data-testid="people-summary">{parts.join(' · ')}</span>}
            action={canManageUsers ? (
                <AddButton onClick={onAddUser} icon={<UserPlus className="h-3.5 w-3.5" aria-hidden="true" />}>
                    {t('admin.sec_people_add', 'Add user')}
                </AddButton>
            ) : undefined}
        />
    );
}

/**
 * How the list is grouped. One organisation to show (the dashboard chose it, or
 * the viewer has one): no grouping by organisation, which would only repeat
 * its name; the list then opens by group.
 */
function useGroupBy(scopeOrgId: string | null | undefined, orgCount: number) {
    const { t } = useTranslation();
    const [choice, setGroupBy] = useState<string>(GROUP_BY.ORG);
    const singleOrg = !!scopeOrgId || orgCount <= 1;
    const groupBy = singleOrg && choice === GROUP_BY.ORG ? GROUP_BY.GROUP : choice;
    const groupByOptions = [
        ...(singleOrg ? [] : [{ value: GROUP_BY.ORG, label: t('admin.sec_people_by_org', 'By organisation') }]),
        { value: GROUP_BY.GROUP, label: t('admin.sec_people_by_group', 'By group') },
        { value: GROUP_BY.FLAT, label: t('admin.sec_people_flat', 'Flat') },
    ];
    return { singleOrg, groupBy, setGroupBy, groupByOptions };
}

/**
 * The organisation chips of a row: only worth one when the person is in more
 * than one organisation (the section header already says which this is), the
 * names in the flat list, none when there is one organisation to show.
 */
function orgChipsOf({ singleOrg, groupBy, groups, orgNameById, t }: {
    singleOrg: boolean; groupBy: string; groups: AdminGroup[]; orgNameById: ReadonlyMap<string, string | undefined>; t: TranslateFn;
}): (u: PeopleUser) => string[] {
    if (singleOrg) return () => [];
    const orgIdsOf = (u: PeopleUser) => [...new Set(membershipFor(u, groups).map((m) => m.orgId))];
    if (groupBy === GROUP_BY.FLAT) return (u) => orgIdsOf(u).map((id) => orgNameById.get(id) || id);
    return (u) => {
        const count = orgIdsOf(u).length;
        return count < 2 ? [] : [t('admin.sec_people_in_n_orgs', 'in {count} orgs', { count })];
    };
}

/**
 * The Security → People directory: everyone the caller may see, grouped by
 * organisation (and within it by group), filterable across six axes.
 *
 * Replaces a two-column <table> that crammed avatar, name, username, email and
 * group chips into one cell and had no search, filter, sort, grouping, empty
 * state or loading state.
 *
 * DATA OWNERSHIP: this component does not fetch. `users` / `groups` /
 * `organizations` arrive as props from UserManagement's existing loadData(), and
 * the mutation modals stay there and call loadData() on save. A second cache
 * here would be a second thing to invalidate.
 */
export default function PeopleDirectory({
    users = [],
    groups = [],
    organizations = [],
    loading = false,
    canManageUsers = false,
    viewerIsPlatformAdmin,
    viewerHomeOrgId,
    scopeOrgId,
    onAddUser,
    onEditUser,
    onResetMfa,
    onDeleteUser,
    onApproveUser,
    onRejectUser,
}: PeopleDirectoryProps) {
    const { t } = useTranslation();
    const { singleOrg, groupBy, setGroupBy, groupByOptions } = useGroupBy(scopeOrgId, organizations.length);

    // The synthetic 'admin' row (adminRoutes.js:133-139) is a system account, not
    // a person in an organisation — it has no org and would sit alone in the
    // "No organisation" bucket forever.
    const people = useMemo(() => users.filter((u) => !u.isSystem), [users]);

    const { filters, setFilter, clear, active, filtered } = useUserFilters(people, { groups });

    const directory = useUserDirectory(filtered, groups, organizations, {
        groupBy,
        // Scoping to one org must not drag a two-org person's OTHER org header
        // into the view. ORG_NONE is not an org — the filter already reduced the
        // list to people who have none. The dashboard's organisation, when chosen, is the only one.
        onlyOrgId: scopeOrgId || (filters.org !== 'all' && filters.org !== ORG_NONE ? filters.org : null),
        noOrgTitle: t('admin.sec_people_no_org', 'No organisation'),
        noGroupTitle: t('admin.sec_people_no_group', 'No group'),
        allTitle: t('admin.sec_people_all', 'All people'),
    });

    const orgNameById = useMemo(
        () => new Map(organizations.map((o) => [o.id, o.name])),
        [organizations],
    );

    const orgChipsFor = orgChipsOf({ singleOrg, groupBy, groups, orgNameById, t });

    const rowProps = {
        canManage: canManageUsers,
        viewerIsPlatformAdmin,
        viewerHomeOrgId,
        onEdit: onEditUser,
        onResetMfa,
        onDelete: onDeleteUser,
        onApprove: onApproveUser,
        onReject: onRejectUser,
    };

    return (
        <div>
            <PeopleHeader
                people={people.length}
                orgs={organizations.length}
                groups={groups.length}
                singleOrg={singleOrg}
                canManageUsers={canManageUsers}
                onAddUser={onAddUser}
            />

            <div className="overflow-hidden rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)]">
                {loading ? (
                    <UserListSkeleton />
                ) : people.length === 0 ? (
                    <EmptyState
                        icon={<UsersIcon className="w-10 h-10 opacity-30" />}
                        title={t('admin.sec_people_none_title', 'No people yet')}
                        description={t(
                            'admin.sec_people_none_desc',
                            'People appear here once they are added to an organisation or a group.',
                        )}
                        action={
                            canManageUsers
                                ? { label: t('admin.sec_people_add', 'Add user'), onClick: onAddUser, icon: <UserPlus className="w-4 h-4" /> }
                                : undefined
                        }
                    />
                ) : (
                    <>
                        <UserFilterBar
                            filters={filters}
                            setFilter={setFilter}
                            clear={clear}
                            active={active}
                            shownCount={directory.distinctCount}
                            totalCount={people.length}
                            groups={groups}
                            organizations={singleOrg ? null : organizations}
                            showVia
                            countLabel={(shown: number, total: number) =>
                                t('admin.sec_people_showing', '{count} of {total} people', { count: shown, total })
                            }
                        />

                        <div className="px-5 py-2 border-b border-[var(--border-default)] flex items-center gap-3">
                            <SegmentedControl
                                value={groupBy}
                                onChange={setGroupBy}
                                options={groupByOptions}
                                size="sm"
                                ariaLabel={t('admin.sec_people_group_by', 'Group people by')}
                            />
                        </div>

                        {directory.sections.length === 0 ? (
                            <EmptyState
                                icon={<Search className="w-8 h-8 opacity-30" />}
                                title={t('admin.sec_people_nomatch_title', 'No people match the current filters')}
                                description={t('admin.sec_people_nomatch_desc', 'Try widening or clearing the filters.')}
                                action={{ label: t('admin.org_clear_filters', 'Clear'), onClick: clear, variant: 'secondary' }}
                            />
                        ) : (
                            <div>
                                {directory.sections.map((s) => (
                                    <PeopleGroupSection
                                        key={s.key}
                                        section={s}
                                        rowProps={rowProps}
                                        orgChipsFor={orgChipsFor}
                                    />
                                ))}
                            </div>
                        )}

                        {directory.multiOrgCount > 0 && (
                            <div className="px-5 py-2.5 border-t border-[var(--border-default)] flex items-start gap-2 text-xs text-[var(--text-muted)]">
                                <Building2 className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" aria-hidden="true" />
                                <p>
                                    {nOf(
                                        t,
                                        'admin_people.multiorg_note',
                                        directory.multiOrgCount,
                                        '{count} person belongs to more than one organisation and is listed under each. The totals above count each person once.',
                                        '{count} people belong to more than one organisation and are listed under each. The totals above count each person once.',
                                    )}
                                </p>
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
