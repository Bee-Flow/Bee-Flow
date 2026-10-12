// "What the agent may do here": the three switches, the agent's tools per
// integration (withheld ones struck through), and the two notes.
//
// Every state of the server's answer is a sentence somebody can act on:
// checking, could-not-check, cannot-be-used, the withheld tools, a degraded
// registry. A failed read is never drawn as "no tools": the author would read
// it as a fact about their agent and turn off a permission it needed.
import { Cloud, Globe, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import type { AgentPermissions, AgentStepPreview } from '../../../../../../api/queries/automation/agents';
import type { TranslateFn } from '../../../../../../hooks/useTranslation';
// The product's counted-phrase helper: the i18n guard knows it and checks
// both halves of the pair.
import { nOf } from '../../../../../admin/Studio/KnowledgeStudio/plural';
import { humanizeToolName } from '../../displayHelpers';
import { SectionNote, hintTextClass } from '../formPrimitives';
import { toolGroupsOf, withheldReasonText } from './agentStepModel';
import { Switch } from './StepSkillsList';

interface CatalogApp { id?: string; label?: string; actions?: Array<{ name?: string; label?: string; integrationLabel?: string }> }

function toolLabel(name: string, apps: CatalogApp[]): string {
    for (const app of apps) {
        const action = (app.actions || []).find((a) => a.name === name);
        if (!action) continue;
        const appLabel = app.label || action.integrationLabel || '';
        const actionLabel = action.label || humanizeToolName(name);
        return appLabel ? `${appLabel}: ${actionLabel}` : actionLabel;
    }
    return humanizeToolName(name);
}

function IntegrationIcon({ integration }: { integration: string }) {
    const k = integration.toLowerCase();
    if (k.includes('nextcloud')) return <Cloud size={11} aria-hidden="true" />;
    if (k.includes('web')) return <Globe size={11} aria-hidden="true" />;
    return null;
}

function PermissionRow({ on, label, sub, onChange, children = null }: {
    on: boolean; label: string; sub?: string | null; onChange: (on: boolean) => void; children?: ReactNode;
}) {
    return (
        <div className="flex flex-col gap-1 px-3 py-2">
            <div className="flex items-center gap-2 text-[12px]">
                <Switch on={on} label={label} onChange={onChange} />
                <span className="font-medium text-[var(--text-primary)]">{label}</span>
                {sub ? <span className="text-[11px] text-[var(--text-tertiary)]">{sub}</span> : null}
            </div>
            {children}
        </div>
    );
}

export interface AgentPermissionsPanelProps {
    permissions: AgentPermissions;
    onChange: (key: keyof AgentPermissions, on: boolean) => void;
    preview: AgentStepPreview | null;
    status: 'loading' | 'error' | 'ok';
    apps: CatalogApp[];
    t: TranslateFn;
}

function ToolChips({ preview, apps, t }: { preview: AgentStepPreview; apps: CatalogApp[]; t: TranslateFn }) {
    const groups = toolGroupsOf(preview, apps);
    if (preview.error) {
        return (
            <SectionNote tone="warn">
                {t('automation_editor.agent_capsule_list_unreadable', 'The tools of this agent could not be listed just now, so they are not shown. That is not the same as this agent having none — try again in a moment.')}
            </SectionNote>
        );
    }
    if (groups.length === 0) {
        return <p className={hintTextClass()}>{t('automation_editor.agent_capsule_no_tools', 'No tools — the agent answers with its role, its knowledge and its skills.')}</p>;
    }
    return (
        <div className="flex flex-wrap gap-1 pl-[34px]">
            {groups.map((g) => (
                <span
                    key={g.integration}
                    title={g.withheld ? withheldReasonText(t, g.reason) : g.tools.map((n) => toolLabel(n, apps)).join(', ')}
                    data-withheld={g.withheld ? 'true' : undefined}
                    className={`inline-flex items-center gap-1 rounded-full border border-[var(--border-default)] px-2 py-0.5 text-[11px] ${
                        g.withheld ? 'text-[var(--text-tertiary)] line-through' : 'bg-[var(--bg-secondary)] text-[var(--text-secondary)]'}`}
                >
                    <IntegrationIcon integration={g.integration} />
                    {g.label}
                </span>
            ))}
        </div>
    );
}

/** The notes under the switches: draft runtime, withheld tools, the two standing notes. */
function AgentNotes({ preview, apps, t }: { preview: AgentStepPreview | null; apps: CatalogApp[]; t: TranslateFn }) {
    const withheld = preview?.withheld || [];
    const confirmNames = withheld.filter((w) => w.reason === 'confirm').map((w) => w.name);
    const permissionCount = withheld.filter((w) => w.reason === 'permission').length;
    // Hoisted: the i18n guard finds a key handed to nOf() with a regex that
    // stops at the first bracket in the call.
    const withheldLabels = confirmNames.map((n) => toolLabel(n, apps)).join(', ');
    return (
        <>
            {preview?.runtimeSource === 'live' ? (
                <p className={hintTextClass()}>
                    {t('automation_editor.agent_capsule_draft', 'This agent has never been published, so the step runs its draft. Publishing it is what freezes what this automation gets.')}
                </p>
            ) : null}
            {permissionCount > 0 ? (
                <p className={hintTextClass()}>
                    {nOf(t, 'automation_editor.agent_capsule_permission', permissionCount,
                        '{count} tool is left out by the permissions above — turn the matching one on to let the agent use it.',
                        '{count} tools are left out by the permissions above — turn the matching one on to let the agent use them.')}
                </p>
            ) : null}
            {confirmNames.length > 0 ? (
                <SectionNote tone="warn">
                    {nOf(t, 'automation_editor.agent_capsule_withheld', confirmNames.length,
                        '{count} tool is left out because someone would have to approve it first: {tools}. An automation runs unattended, so there is nobody to ask. Put an approval step after this one if the automation has to do this anyway.',
                        '{count} tools are left out because someone would have to approve them first: {tools}. An automation runs unattended, so there is nobody to ask. Put an approval step after this one if the automation has to do this anyway.',
                        { tools: withheldLabels })}
                </SectionNote>
            ) : (
                <p className={hintTextClass()}>
                    {t('automations.agent_step.note_confirm', 'Tools that ask to "confirm first" are off in an automation: there is nobody to confirm. Need one anyway? Put an approval step after this one.')}
                </p>
            )}
            {preview?.degraded ? (
                <SectionNote tone="warn">
                    {t('automation_editor.agent_capsule_degraded', 'The tool list could not be checked against the app registry, so this step is given no app tools at all. It is a server-side problem, not a setting here.')}
                </SectionNote>
            ) : null}
            <p className={hintTextClass()}>
                {t('automations.agent_step.note_not_a_chat', 'In an automation the agent is a step, not a conversation partner: it asks nothing back and confirms nothing. When in doubt, it fills in "Points of attention".')}
            </p>
        </>
    );
}

export default function AgentPermissionsPanel({ permissions, onChange, preview, status, apps, t }: AgentPermissionsPanelProps) {
    const kbNames = (preview?.knowledgeBases || []).map((k) => k.name).join(', ');

    return (
        <section className="flex flex-col gap-2" aria-label={t('automation_editor.agent_permissions_label', 'What the agent may do here')}>
            <div className="flex items-center gap-1.5 text-[12px] font-semibold text-[var(--text-primary)]">
                <ShieldCheck size={13} aria-hidden="true" />
                {t('automation_editor.agent_permissions_label', 'What the agent may do here')}
            </div>
            <div className="flex flex-col divide-y divide-[var(--border-default)] rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)]">
                <PermissionRow
                    on={permissions.startAutomations}
                    label={t('automations.agent_step.perm_start', 'Start automations itself')}
                    sub={permissions.startAutomations ? null : t('automations.agent_step.perm_start_off', 'off · only answers')}
                    onChange={(on) => onChange('startAutomations', on)}
                />
                <PermissionRow
                    on={permissions.useKnowledge}
                    label={t('automations.agent_step.perm_knowledge', 'Consult knowledge bases')}
                    sub={kbNames || null}
                    onChange={(on) => onChange('useKnowledge', on)}
                />
                <PermissionRow
                    on={permissions.useTools}
                    label={t('automations.agent_step.perm_tools', 'The agent\'s tools')}
                    onChange={(on) => onChange('useTools', on)}
                >
                    {status === 'loading' ? (
                        <p className={`pl-[34px] ${hintTextClass()}`}>{t('automation_editor.agent_capsule_checking', 'Checking what this agent may do here…')}</p>
                    ) : status === 'error' ? (
                        <SectionNote tone="warn">
                            {t('automation_editor.agent_capsule_unreadable', 'Could not check what this agent brings to this step. Nothing is wrong with the step — this panel just has nothing to show you right now.')}
                        </SectionNote>
                    ) : preview ? <ToolChips preview={preview} apps={apps} t={t} /> : null}
                </PermissionRow>
            </div>
            <AgentNotes preview={preview} apps={apps} t={t} />
        </section>
    );
}
