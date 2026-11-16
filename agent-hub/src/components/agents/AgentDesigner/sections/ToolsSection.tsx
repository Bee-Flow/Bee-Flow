import { Link2 } from 'lucide-react';
import { INTEGRATION_CATALOG } from '../integrations';
import { filterAvailableIntegrations, needsPersonalConnection } from '../integrationAvailability';
import { USER_ACCESS, type DesignerIntegrationAccess } from '../useDesignerIntegrationAccess';
import ConnectionPolicyPicker from '@/components/shared/ConnectionPolicyPicker';
import SectionHeader from '@/components/shared/SectionHeader';
import { SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import Toggle from '@/components/shared/Toggle';
import { ALERT_INFO, CHIP } from '@/components/shared/adminUi';
import { useTranslation } from '@/hooks/useTranslation';
import { availabilityUnknownText } from '@/utils/integrationAvailability';
import type { DesignerSectionProps } from './sectionProps';

type CatalogItem = (typeof INTEGRATION_CATALOG)[number];

export type ToolsSectionProps = DesignerSectionProps & {
  /** How to decide what may be attached (useDesignerIntegrationAccess); the person's own access when absent. */
  access?: DesignerIntegrationAccess;
};

const TILE = 'flex items-center gap-3 rounded-lg border border-[var(--border-default)] px-3 py-2.5 transition-colors';
const TILE_ON = `${TILE} cursor-pointer bg-[var(--bg-card)] hover:bg-[var(--item-hover-bg)]`;
const TILE_OFF = `${TILE} cursor-pointer border-dashed hover:bg-[var(--item-hover-bg)]`;
const TILE_LOCKED = `${TILE} border-dashed opacity-50`;

/** One integration: the whole tile toggles it, as does the switch. `locked`: the master switch is off. */
function IntegrationTile({ item, selected, locked, ownAccount, onToggle }: {
  item: CatalogItem; selected: boolean; locked: boolean; ownAccount: boolean; onToggle: () => void;
}) {
  const { t } = useTranslation();
  const toggle = () => { if (!locked) onToggle(); };
  return (
    <div className={locked ? TILE_LOCKED : selected ? TILE_ON : TILE_OFF} onClick={toggle} aria-disabled={locked || undefined}>
      <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--bg-secondary)] ${selected ? '' : 'opacity-50'}`}>
        {item.iconSvg}
      </div>
      <div className={`min-w-0 flex-1 ${selected ? '' : 'opacity-60'}`}>
        <p className="m-0 truncate text-[13px] font-medium text-[var(--text-primary)]">{item.label}</p>
        <p className="m-0 truncate text-[11px] text-[var(--text-tertiary)]">{item.description}</p>
        {ownAccount && (
          <span className={`${CHIP} mt-1`} title={t('agent_designer.tools_own_account_hint', 'Each person who uses this agent connects their own account or key.')}>
            {t('agent_designer.tools_own_account', 'Own account per person')}
          </span>
        )}
      </div>
      <span className="shrink-0" onClick={e => e.stopPropagation()}>
        <Toggle size="sm" checked={selected} onChange={toggle} ariaLabel={item.label} disabled={locked} />
      </span>
    </div>
  );
}

/** Nothing to attach: where integrations come from, for the person editing or for the organisation. */
function NoIntegrations({ adminMode }: { adminMode: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center gap-1 rounded-lg border border-dashed border-[var(--border-default)] px-6 py-8 text-center">
      <Link2 className="mb-1 h-6 w-6 text-[var(--text-tertiary)]" aria-hidden="true" />
      <p className="m-0 text-[13px] font-medium text-[var(--text-secondary)]">{t('agent_studio.tools_no_integrations_available', 'No integrations available')}</p>
      <p className="m-0 text-xs text-[var(--text-tertiary)]">
        {adminMode
          ? t('agent_designer.tools_none_admin', 'This organisation has no integrations available. Integration status shows what is set up, Access what the organisation may use.')
          : t('agent_designer.tools_none_user', 'Connect an account or add an API key in your Settings to use integrations here.')}
      </p>
    </div>
  );
}

/** The switch above the list: off, the agent uses no integration and no web search at all. */
function MasterSwitch({ on, onChange, readOnly }: { on: boolean; onChange: (on: boolean) => void; readOnly?: boolean }) {
  const { t } = useTranslation();
  return (
    <SettingsList>
      <Toggle
        flat
        checked={on}
        onChange={onChange}
        disabled={readOnly}
        label={t('agent_designer.tools_master', 'Integrations and web search')}
        description={on
          ? t('agent_designer.tools_master_on', 'The agent may use the integrations switched on below.')
          : t('agent_designer.tools_master_off', 'Off: the agent uses no integration and no web search, whatever is switched on below.')}
      />
    </SettingsList>
  );
}

export const ToolsSection = (props: ToolsSectionProps) => {
  const { selectedAgent, enabledIntegrations, setEnabledIntegrations, integrationStatus, disableExternalTools, setDisableExternalTools, isReadonly } = props;
  const access = props.access ?? USER_ACCESS;
  const { t } = useTranslation();
  // In admin mode this is the organisation's catalogue, so a first toggle on an agent with
  // "every integration" (null) keeps every one the organisation has, not the admin's own.
  const available = filterAvailableIntegrations(INTEGRATION_CATALOG, integrationStatus, access.how);
  // null = all enabled by default
  const isSelected = (id: string) => !enabledIntegrations || enabledIntegrations.includes(id);
  const toggleIntegration = (id: string) => {
    setEnabledIntegrations(prev => {
      const currentList = prev || available.map(a => a.id);
      return currentList.includes(id) ? currentList.filter(x => x !== id) : [...currentList, id];
    });
  };
  const selectedCount = available.filter(a => isSelected(a.id)).length;
  const masterOn = !disableExternalTools;
  // An organisation admin without a definite answer sees only the built-ins (fail closed): a
  // first toggle on "every integration" (null) would seed the list from those and drop the rest.
  const answerMissing = access.how.mode === 'admin' && access.unknown && !access.how.platformAdmin;
  const locked = !masterOn || !!isReadonly || answerMissing;

  return (
    <div className="flex max-w-4xl flex-col gap-6 animate-fadeIn">
      <div data-tour="agent-tools">
        <SectionHeader
          title={t('agent_designer.tools_title', 'Integrations')}
          description={access.adminMode
            ? t('agent_designer.tools_intro_admin', 'Choose which integrations this agent may use. Listed are the integrations available to its organisation.')
            : t('agent_studio.tools_select_which_integrations_this_agent', 'Select which integrations this agent can use. Only integrations you have access to are shown.')}
        />
      </div>

      <MasterSwitch on={masterOn} onChange={on => setDisableExternalTools(!on)} readOnly={!!isReadonly} />

      {access.adminMode && access.unknown && !access.pending && (
        <p className={`${ALERT_INFO} m-0`}>{availabilityUnknownText(t)}</p>
      )}

      {access.pending ? (
        <p className="m-0 text-xs text-[var(--text-tertiary)]">{t('agent_designer.tools_checking', 'Checking which integrations this organisation has…')}</p>
      ) : available.length > 0 ? (
        <SettingsGroup title={t('agent_studio.tools_agent_integrations_selected_count', 'Agent Integrations ({selected_count}/{count})', { selected_count: selectedCount, count: available.length })}>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {available.map(item => (
              <IntegrationTile
                key={item.id}
                item={item}
                selected={isSelected(item.id)}
                locked={locked}
                ownAccount={access.adminMode && needsPersonalConnection(item)}
                onToggle={() => toggleIntegration(item.id)}
              />
            ))}
          </div>
        </SettingsGroup>
      ) : (
        <NoIntegrations adminMode={access.adminMode} />
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
