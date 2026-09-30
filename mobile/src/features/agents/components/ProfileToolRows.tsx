/** One row per tool the agent may call, named from the component catalogue. */

import React from 'react';

import { useTheme } from '@/core/theme/ThemeProvider';
import { Divider, Icon, ListRow } from '@/shared/ui';

import { useAgentComponents, useAgentTools } from '../hooks/queries';
import { toolLabel } from '../model/format';
import type { Agent } from '../model/types';

export function ProfileToolRows({ agent }: { agent: Agent }) {
    const theme = useTheme();
    const tools = useAgentTools(agent.id);
    const components = useAgentComponents();
    return (
        <>
            {(tools.data ?? []).map((tool, index) => (
                <React.Fragment key={tool.componentId}>
                    {index > 0 ? <Divider inset={theme.spacing.lg} /> : null}
                    <ListRow
                        title={toolLabel(tool.componentId, components.data ?? [])}
                        subtitle={
                            tool.params && Object.keys(tool.params).length > 0
                                ? 'Pre-configured by the agent’s author'
                                : undefined
                        }
                        leading={<Icon name="Wrench" size={18} color={theme.colors.textMuted} />}
                    />
                </React.Fragment>
            ))}
        </>
    );
}
