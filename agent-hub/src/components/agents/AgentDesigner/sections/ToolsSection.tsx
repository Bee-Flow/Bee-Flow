import { Link2 } from 'lucide-react';
import { INTEGRATION_CATALOG } from '../integrations';
import ConnectionPolicyPicker from '@/components/shared/ConnectionPolicyPicker';
import SectionHeader from '@/components/shared/SectionHeader';
import { SettingsGroup } from '@/components/shared/SettingsList';
import Toggle from '@/components/shared/Toggle';
import { useTranslation } from '@/hooks/useTranslation';
import type { DesignerSectionProps } from './sectionProps';

type CatalogItem = (typeof INTEGRATION_CATALOG)[number];
type Status = DesignerSectionProps['integrationStatus'];

/** Whether this person can attach one catalogue integration: org gating, then the credential or SSO it needs. */
function isAvailable(item: { id: string; group?: string }, status: Status): boolean {
  if (!status) return false;
  const orgEnabled = status.orgEnabledIntegrations;
  if (orgEnabled && !orgEnabled.includes(item.id)) return false;
  if (item.group === 'google') return !!status.isGoogleUser;
  const byId: Record<string, () => boolean> = {
    fireflies: () => !!status.hasFirefliesKey,
    youtrack: () => !!status.hasYouTrackConfig,
    gamma: () => !!status.hasGammaKey,
    'afas-profit': () => !!status.hasAfasConfig,
    nmbrs: () => !!status.hasNmbrsConfig,
    n8n: () => !!status.hasN8nConfig,
    linkedin: () => !!status.hasLinkedInConfig || !!status.linkedInConnected,
  };
  return byId[item.id] ? byId[item.id]() : true;
}

const TILE_ON = 'flex cursor-pointer items-center gap-3 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] px-3 py-2.5 transition-colors hover:bg-[var(--bg-secondary)]';
const TILE_OFF = 'flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-[var(--border-default)] px-3 py-2.5 transition-colors hover:bg-[var(--bg-secondary)]';

/** One integration: the whole tile toggles it, as does the switch. */
function IntegrationTile({ item, selected, onToggle }: { item: CatalogItem; selected: boolean; onToggle: () => void }) {
  return (
    <div className={selected ? TILE_ON : TILE_OFF} onClick={onToggle}>
      <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--bg-secondary)] ${selected ? '' : 'opacity-50'}`}>
        {item.iconSvg}
      </div>
      <div className={`min-w-0 flex-1 ${selected ? '' : 'opacity-60'}`}>
        <p className="m-0 truncate text-[13px] font-medium text-[var(--text-primary)]">{item.label}</p>
        <p className="m-0 truncate text-[11px] text-[var(--text-tertiary)]">{item.description}</p>
      </div>
      <span className="shrink-0" onClick={e => e.stopPropagation()}>
        <Toggle size="sm" checked={selected} onChange={onToggle} ariaLabel={item.label} />
      </span>
    </div>
  );
}

export const ToolsSection = ({ selectedAgent, enabledIntegrations, setEnabledIntegrations, integrationStatus }: DesignerSectionProps) => {
  const { t } = useTranslation();
  const available = INTEGRATION_CATALOG.filter(item => isAvailable(item, integrationStatus));
  // null = all enabled by default
  const isSelected = (id: string) => !enabledIntegrations || enabledIntegrations.includes(id);
  const toggleIntegration = (id: string) => {
    setEnabledIntegrations(prev => {
      const currentList = prev || available.map(a => a.id);
      return currentList.includes(id) ? currentList.filter(x => x !== id) : [...currentList, id];
    });
  };
  const selectedCount = available.filter(a => isSelected(a.id)).length;

  return (
    <div className="flex max-w-4xl flex-col gap-6 animate-fadeIn">
      <div data-tour="agent-tools">
        <SectionHeader
          title={t('agent_studio.tools_capabilities_integrations', 'Capabilities & Integrations')}
          description={t('agent_studio.tools_select_which_integrations_this_agent', 'Select which integrations this agent can use. Only integrations you have access to are shown.')}
        />
      </div>

      {available.length > 0 ? (
        <SettingsGroup title={t('agent_studio.tools_agent_integrations_selected_count', 'Agent Integrations ({selected_count}/{count})', { selected_count: selectedCount, count: available.length })}>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {available.map(item => (
              <IntegrationTile key={item.id} item={item} selected={isSelected(item.id)} onToggle={() => toggleIntegration(item.id)} />
            ))}
          </div>
        </SettingsGroup>
      ) : (
        <div className="flex flex-col items-center gap-1 rounded-lg border border-dashed border-[var(--border-default)] px-6 py-8 text-center">
          <Link2 className="mb-1 h-6 w-6 text-[var(--text-tertiary)]" aria-hidden="true" />
          <p className="m-0 text-[13px] font-medium text-[var(--text-secondary)]">{t('agent_studio.tools_no_integrations_available', 'No integrations available')}</p>
          <p className="m-0 text-xs text-[var(--text-tertiary)]">{t('agent_studio.tools_connect_via_google_sso_or_configure', 'Connect via Google SSO or configure API keys in Settings')}</p>
        </div>
      )}

      {/* Connection lending (gated): owner lends a named connection for
          this agent, or recipients bring their own (default). */}
      <ConnectionPolicyPicker
        resourceType="agent"
        resourceId={selectedAgent?.id || null}
        providers={enabledIntegrations || INTEGRATION_CATALOG.map(i => i.id)}
      />
    </div>
  );
};
