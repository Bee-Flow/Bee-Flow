/**
 * "Edit with AI" at /agents/<id>/refine — describe a change, the web's agent
 * builder AI applies it, and a Done card says what changed with Undo.
 * `?q=` carries the first ask from "Create with AI".
 *
 * Refining is an edit: someone who may not edit this agent gets the reason,
 * not a composer whose every send ends in a 403.
 */

import { useRouter } from 'expo-router';
import React from 'react';

import { useHasPermission } from '@/core/access';
import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { QueryScreen } from '@/shared/patterns';
import { Banner, Icon, IconButton, ScreenHeader } from '@/shared/ui';

import { RefineChat } from '../components/refine/RefineChat';
import { useAgentDraftDetail } from '../hooks/editor';
import type { AgentDetail } from '../model/draft';
import { canEditAgent } from '../model/permissions';

function RefineHeader({ id, agent }: { id: string; agent: AgentDetail | undefined }) {
    const t = useTranslation();
    const theme = useTheme();
    const router = useRouter();
    return (
        <ScreenHeader
            title={t('mobile.agents.edit_with_ai', 'Edit with AI')}
            subtitle={agent?.name}
            actions={
                <IconButton
                    icon={<Icon name="PenLine" size={20} color={theme.colors.textPrimary} />}
                    accessibilityLabel={t('common.edit', 'Edit')}
                    onPress={() => router.replace(`/agents/${id}/edit`)}
                />
            }
        />
    );
}

function RefineBody({ agent, q }: { agent: AgentDetail; q?: string }) {
    const t = useTranslation();
    const manage = useHasPermission('manage_agents');
    if (!canEditAgent(agent, manage)) {
        return (
            <Banner tone="info" icon="Lock">
                {t('mobile.agents.editor.read_only', 'You can open this agent but not change it: that takes the permission to manage agents, and edit rights on this one.')}
            </Banner>
        );
    }
    return <RefineChat agent={agent} initial={q} />;
}

export function AgentRefineScreen({ id, q }: { id: string; q?: string }) {
    const detail = useAgentDraftDetail(id);
    return (
        <QueryScreen query={detail} scroll={false} screen={{ avoidKeyboard: true }} header={(agent) => <RefineHeader id={id} agent={agent} />}>
            {(agent) => <RefineBody agent={agent} q={q} />}
        </QueryScreen>
    );
}
