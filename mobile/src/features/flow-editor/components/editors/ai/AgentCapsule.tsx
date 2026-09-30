/**
 * What the chosen agent would actually bring to this step — the web's
 * AgentToolCapsule (agentStepFields.jsx), asked of the server
 * (GET /api/automation/catalog/agent/:id), which runs the SAME rights checks
 * the run does. Every state is a sentence someone can act on: checking,
 * could-not-check, cannot-be-used, the tools left out and why. A failed read
 * is never drawn as "No tools": the author would turn off a permission their
 * agent needed.
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { AgentPreview, CatalogAppRow } from '@/features/flow-editor/api';
import { useAgentPreview } from '@/features/flow-editor/hooks';
import { Icon, Text } from '@/shared/ui';

import { toolLabel } from './aiModel';
import { Note } from '../shared/Note';
import { Warn } from '../shared/Warn';

/** The product's counted phrase: the base key for one, `_plural` for the rest. */
interface Counted {
    key: string;
    n: number;
    one: string;
    many: string;
    params?: Record<string, string | number>;
}

const counted = (t: TranslateFn, { key, n, one, many, params = {} }: Counted) =>
    n === 1 ? t(key, one, { count: n, ...params }) : t(`${key}_plural`, many, { count: n, ...params });

function Body({ data, apps }: { data: AgentPreview; apps: readonly CatalogAppRow[] }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const confirm = data.withheld.filter((w) => w.reason === 'confirm').map((w) => w.name);
    const permission = data.withheld.filter((w) => w.reason === 'permission').length;
    const other = data.withheld.length - confirm.length - permission;
    return (
        <View style={styles.capsule}>
            <View style={styles.title}>
                <Icon name="Sparkles" size={14} color={styles.glyph.color} />
                <Text variant="caption" weight="medium" tone="secondary">
                    {t('routine_editor.agent_capsule_title', 'What runs here')}
                </Text>
            </View>
            {data.runtimeSource === 'live' ? (
                <Note>{t('routine_editor.agent_capsule_draft', 'This agent has never been published, so the step runs its draft. Publishing it is what freezes what this routine gets.')}</Note>
            ) : null}
            {data.error ? (
                <Warn>
                    {t('routine_editor.agent_capsule_list_unreadable', 'The tools of this agent could not be listed just now, so they are not shown. That is not the same as this agent having none — try again in a moment.')}
                </Warn>
            ) : (
                <Note>
                    {data.allowed.length === 0
                        ? t('routine_editor.agent_capsule_no_tools', 'No tools — the agent answers with its role, its knowledge and its skills.')
                        : counted(t, {
                              key: 'routine_editor.agent_capsule_tools',
                              n: data.allowed.length,
                              one: '{count} tool is available to this step.',
                              many: '{count} tools are available to this step.',
                          })}
                </Note>
            )}
            {permission > 0 ? (
                <Note>
                    {counted(t, {
                        key: 'routine_editor.agent_capsule_permission',
                        n: permission,
                        one: '{count} tool is left out by the permissions above — turn the matching one on to let the agent use it.',
                        many: '{count} tools are left out by the permissions above — turn the matching one on to let the agent use them.',
                    })}
                </Note>
            ) : null}
            {confirm.length > 0 ? (
                <Warn>
                    {counted(t, {
                        key: 'routine_editor.agent_capsule_withheld',
                        n: confirm.length,
                        one: '{count} tool is left out because someone would have to approve it first: {tools}. A routine runs unattended, so there is nobody to ask. Put an approval step after this one if the routine has to do this anyway.',
                        many: '{count} tools are left out because someone would have to approve them first: {tools}. A routine runs unattended, so there is nobody to ask. Put an approval step after this one if the routine has to do this anyway.',
                        params: { tools: confirm.map((n) => toolLabel(n, apps)).join(', ') },
                    })}
                </Warn>
            ) : null}
            {other > 0 ? (
                <Note>
                    {counted(t, {
                        key: 'routine_editor.agent_capsule_other',
                        n: other,
                        one: '{count} more tool of this agent is not available to this step.',
                        many: '{count} more tools of this agent are not available to this step.',
                    })}
                </Note>
            ) : null}
            {data.degraded ? (
                <Warn>
                    {t('routine_editor.agent_capsule_degraded', 'The tool list could not be checked against the app registry, so this step is given no app tools at all. It is a server-side problem, not a setting here.')}
                </Warn>
            ) : null}
        </View>
    );
}

export function AgentCapsule({ agentId, permissions, allowList, apps }: { agentId: string; permissions: Record<string, boolean>; allowList: string[] | null; apps: readonly CatalogAppRow[] }) {
    const t = useTranslation();
    const preview = useAgentPreview(agentId, { ...permissions, tools: allowList ?? undefined });
    if (preview.isPending) return <Note>{t('routine_editor.agent_capsule_checking', 'Checking what this agent may do here…')}</Note>;
    if (preview.isError || !preview.data) {
        return (
            <Warn>
                {t('routine_editor.agent_capsule_unreadable', 'Could not check what this agent brings to this step. Nothing is wrong with the step — this panel just has nothing to show you right now.')}
            </Warn>
        );
    }
    if (preview.data.canUse === false) {
        return (
            <Warn>
                {t('routine_editor.agent_capsule_forbidden', "This agent cannot be used by this routine. Pick another one — an agent has to be published and shared with the routine's owner.")}
            </Warn>
        );
    }
    return <Body data={preview.data} apps={apps} />;
}

const makeStyles = (theme: Theme) => ({
    capsule: {
        gap: theme.spacing.xs,
        padding: theme.spacing.md,
        borderRadius: theme.radii.md,
        borderWidth: 1,
        borderColor: theme.colors.borderDefault,
        backgroundColor: theme.colors.bgSecondary,
    } satisfies ViewStyle,
    title: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs } satisfies ViewStyle,
    glyph: { color: theme.colors.textSecondary },
});
