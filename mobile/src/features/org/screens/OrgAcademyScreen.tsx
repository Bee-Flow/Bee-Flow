/**
 * Academy (web: pages/settings/OrgAcademyPanel.jsx, its Overview tab): how the
 * team is doing in the Learning Center — four totals, then every member with
 * their courses, badges, certificates and last activity, searchable and
 * filterable by a completed course. Read-only.
 *
 * Gated as the web gates the section: an org admin, and the `learning_center`
 * capability — shown locked with the reason when the plan lacks it, never
 * before the entitlements have answered. OrgSettingsFrame draws both notices. The web's other two tabs (required
 * training rules and custom-course authoring) are desk work and stay there.
 */

import React, { useState } from 'react';
import type { ListRenderItem } from 'react-native';

import { lockHint, useGate, type LockReason } from '@/core/access';
import { useTranslation } from '@/core/i18n';
import { QueryList } from '@/shared/patterns';

import { AcademyHeader } from '../components/AcademyHeader';
import { AcademyMemberRow } from '../components/AcademyMemberRow';
import type { OrgDenied } from '../components/OrgLockedScreen';
import { OrgSettingsFrame, type FrameQuery } from '../components/OrgSettingsFrame';
import { useAcademyOverview } from '../hooks/sectionQueries';
import { useOrgContext } from '../hooks/useOrgSections';
import { byActivity, memberMatches } from '../model/format';
import type { AcademyMember, AcademyOverview } from '../model/sectionTypes';

type Row = AcademyMember & { courseCount: number };

const renderMember: ListRenderItem<Row> = ({ item }) => <AcademyMemberRow member={item} courseCount={item.courseCount} />;
const keyOf = (row: Row) => row.userId;

function AcademyBody({ query, overview }: { query: FrameQuery<AcademyOverview>; overview: AcademyOverview }) {
    const t = useTranslation();
    const [courseId, setCourseId] = useState<string | null>(null);
    const courseCount = overview.courses.length;
    const rows = byActivity(overview.members).map((m) => ({ ...m, courseCount }));
    return (
        <QueryList
            // The frame already says when a refresh failed; one note is enough.
            query={{ ...query, data: rows, isError: false }}
            renderItem={renderMember}
            keyExtractor={keyOf}
            search={{ placeholder: t('org.academy.search', 'Search members…'), match: memberMatches }}
            filter={courseId ? (m) => m.coursesDone.includes(courseId) : undefined}
            ListHeaderComponent={<AcademyHeader overview={overview} courseId={courseId} onCourse={setCourseId} />}
            empty={{ icon: 'GraduationCap', title: t('org.academy.empty', 'No learning activity in your organisation yet.') }}
            noMatch={{ title: t('org.academy.no_matches', 'No members match the current filters.') }}
        />
    );
}

export function OrgAcademyScreen() {
    const t = useTranslation();
    const { orgId } = useOrgContext();
    const gate = useGate({ orgAdmin: true, can: 'learning_center', lockOn: 'disable' });
    const allowed = gate.visible && !gate.locked && Boolean(orgId);
    const overview = useAcademyOverview(allowed);
    const denied: OrgDenied =
        gate.locked && gate.reason
            ? { icon: 'Lock', title: t('settings.academy', 'Academy'), message: lockHint(gate.reason as LockReason, t) }
            : {
                  icon: 'Lock',
                  title: t('mobile.org.admins_only_title', 'For organisation administrators'),
                  message: t('mobile.org.academy_admins_only', 'Only an administrator of your organisation can see the team’s learning progress.'),
              };
    return (
        <OrgSettingsFrame
            title={t('settings.academy', 'Academy')}
            subtitle={t('org.academy.subtitle', 'Course progress, badges and certificates across your team.')}
            allowed={allowed}
            denied={denied}
            pending={gate.reason === 'pending'}
            list
            query={overview}
        >
            {(data) => <AcademyBody query={overview} overview={data} />}
        </OrgSettingsFrame>
    );
}
