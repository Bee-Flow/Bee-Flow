/**
 * New agent, from the Agents list — the web's AgentStudio "New agent" menu:
 * "Create with AI" or "Create empty agent". Shown only with `manage_agents`,
 * the permission POST /agents requires. The list's empty state opens the same
 * menu (NewAgentMenu).
 */

import { useRouter } from 'expo-router';
import React, { useState } from 'react';

import { useHasPermission } from '@/core/access';
import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { ActionMenu, Icon, IconButton } from '@/shared/ui';

import { canCreateAgents } from '../model/permissions';

/** The two ways to start an agent. */
export function NewAgentMenu({ visible, onClose }: { visible: boolean; onClose: () => void }) {
    const t = useTranslation();
    const router = useRouter();
    return (
        <ActionMenu
            visible={visible}
            onClose={onClose}
            title={t('agent_studio.new_agent', 'New agent')}
            items={[
                { id: 'ai', label: t('agent_studio.create_with_ai', 'Create with AI'), icon: 'Sparkles', onPress: () => router.push('/agents/new?ai=1') },
                { id: 'empty', label: t('agent_studio.create_empty', 'Create empty agent'), icon: 'PenLine', onPress: () => router.push('/agents/new') },
            ]}
        />
    );
}

export function NewAgentButton() {
    const t = useTranslation();
    const theme = useTheme();
    const [open, setOpen] = useState(false);
    if (!canCreateAgents(useHasPermission('manage_agents'))) return null;
    return (
        <>
            <IconButton
                icon={<Icon name="Plus" size={22} color={theme.colors.textPrimary} />}
                accessibilityLabel={t('agent_studio.new_agent', 'New agent')}
                onPress={() => setOpen(true)}
            />
            <NewAgentMenu visible={open} onClose={() => setOpen(false)} />
        </>
    );
}
