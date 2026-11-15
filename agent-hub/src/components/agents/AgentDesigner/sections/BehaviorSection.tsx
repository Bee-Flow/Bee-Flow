import SectionHeader from '@/components/shared/SectionHeader';
import { SettingsList } from '@/components/shared/SettingsList';
import Toggle from '@/components/shared/Toggle';
import { useTranslation } from '@/hooks/useTranslation';
import type { DesignerSectionProps } from './sectionProps';

/**
 * How the agent behaves in a chat. Integrations and web search have their
 * master switch on the Integrations section, the web embed is under Share & embed.
 */
export const BehaviorSection = (props: DesignerSectionProps) => {
  const { allowCopy, setAllowCopy, isReadonly } = props;
  const { t } = useTranslation();
  return (
    <div className="flex max-w-4xl flex-col gap-6 animate-fadeIn">
      <SectionHeader title={t('agent_studio.behavior_behavior_settings', 'Behavior Settings')} />
      <SettingsList>
        <Toggle
          flat
          checked={allowCopy}
          onChange={setAllowCopy}
          disabled={!!isReadonly}
          label={t('agent_studio.behavior_allow_copying', 'Allow Copying')}
          description={t('agent_studio.behavior_allow_copying_hint', 'Users can copy message content to clipboard')}
        />
      </SettingsList>
    </div>
  );
};
