/**
 * Who may use the agent — the web's publish capsule (PATCH /agents/:id/publish).
 * Applied at once, not with the draft: it is a different verb on the server
 * and the web does the same. A failure says so and leaves the row as it was.
 */

import React, { useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useAgentAudience } from '@/features/agents/hooks/editor';
import type { AgentDetail } from '@/features/agents/model/draft';
import { audienceLabel } from '@/features/agents/model/editorOptions';
import { AudienceSheet, useOrgGroups, type Audience } from '@/shared/patterns';
import { Group, SettingRow, useToast } from '@/shared/ui';

export function SharingRow({ agent, disabled }: { agent: AgentDetail; disabled: boolean }) {
    const t = useTranslation();
    const { toast } = useToast();
    const [open, setOpen] = useState(false);
    const groups = useOrgGroups(open);
    const audience = useAgentAudience(agent.id);
    const label = t('agent_wizard.section.publishing', 'Publishing');

    const change = (next: Audience) =>
        audience.mutate(
            { isPublished: next.isShared, sharedGroups: next.sharedGroups },
            { onError: (e) => toast(describeError(e).message, 'error') },
        );

    return (
        <>
            <Group>
                <SettingRow
                    label={label}
                    value={audienceLabel(t, agent.is_published, agent.shared_groups)}
                    onPress={disabled || audience.isPending ? undefined : () => setOpen(true)}
                />
            </Group>
            <AudienceSheet
                visible={open}
                onClose={() => setOpen(false)}
                name={agent.name}
                value={{ isShared: agent.is_published, sharedGroups: agent.shared_groups }}
                groups={groups.data ?? null}
                groupsLoading={groups.isLoading}
                onRetryGroups={() => void groups.refetch()}
                canShare={Boolean(agent.organization_id)}
                onChange={change}
            />
        </>
    );
}
