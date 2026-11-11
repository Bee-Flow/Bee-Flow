import { useState as useLocalState } from 'react';
import { Plus, X } from 'lucide-react';
import ModelTierSelector from '@/components/licensing/ModelTierSelector';
import SectionHeader from '@/components/shared/SectionHeader';
import { FIELD_INPUT, SettingBlock, SettingRow, SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import { PRIMARY_BTN, QUIET_BTN, SECONDARY_BTN } from '@/components/mcpLibrary/ui';
import VersionHistory from '../../VersionHistory';
import { useTranslation } from '@/hooks/useTranslation';
import type { DesignerSectionProps } from './sectionProps';
import { mutate, ApiError } from '@/api/mutate';
import AvatarPicker from './AvatarPicker';

type CategoryProps = Pick<DesignerSectionProps, 'API_BASE' | 'categoryId' | 'setCategoryId' | 'agentCategories' | 'setAgentCategories' | 'adminOrgId'>;

/** The category select with a + to create one inline; without any categories, only the + as a quiet button. */
function CategoryControl({ API_BASE, categoryId, setCategoryId, agentCategories, setAgentCategories, adminOrgId }: CategoryProps) {
  const { t } = useTranslation();
  const [showNewCategory, setShowNewCategory] = useLocalState(false);
  const [newCategoryName, setNewCategoryName] = useLocalState('');

  const handleCreateCategory = async () => {
    if (!newCategoryName.trim()) return;
    try {
      // In the admin dashboard with one organisation chosen, the category is created in it (the list shows only its categories).
      const orgQuery = adminOrgId ? `?orgId=${encodeURIComponent(adminOrgId)}` : '';
      const res = await mutate(`${API_BASE}/agents/categories${orgQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newCategoryName.trim() })
      }).catch((err: unknown) => {
          if (err instanceof ApiError) return null;
          throw err;
      });
      if (res) {
        const cat = await res.json();
        setAgentCategories(prev => [...prev, cat]);
        setCategoryId(cat.id);
        setNewCategoryName('');
        setShowNewCategory(false);
      }
    } catch (err) { console.error('Failed to create category:', err); }
  };

  if (showNewCategory) {
    return (
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={newCategoryName}
          onChange={(e) => setNewCategoryName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleCreateCategory()}
          className={`${FIELD_INPUT} flex-1`}
          placeholder={t('agent_studio.identity_category_name', 'Category name...')}
          autoFocus
        />
        <button type="button" onClick={handleCreateCategory} disabled={!newCategoryName.trim()} className={PRIMARY_BTN}>
          {t('agent_studio.identity_create', 'Create')}
        </button>
        <button type="button" onClick={() => { setShowNewCategory(false); setNewCategoryName(''); }} className={QUIET_BTN} aria-label={t('common.cancel', 'Cancel')}>
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    );
  }
  if (!agentCategories || agentCategories.length === 0) {
    return (
      <button type="button" onClick={() => setShowNewCategory(true)} className={QUIET_BTN}>
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        {t('agent_studio.identity_add_to_category', 'Add to category')}
      </button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <select
        id="agent-category"
        value={categoryId || ''}
        onChange={(e) => setCategoryId(e.target.value || null)}
        className={`${FIELD_INPUT} flex-1`}
      >
        <option value="">{t('agent_studio.identity_no_category', 'No category')}</option>
        {agentCategories.map(c => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => setShowNewCategory(true)}
        className={`${SECONDARY_BTN} px-2`}
        title={t('agent_studio.identity_create_new_category', 'Create new category')}
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

export const IdentitySection = (props: DesignerSectionProps) => {
  const {
    selectedAgent, name, setName, description, setDescription, systemPrompt, setSystemPrompt,
    avatar, setAvatar, showEmojiPicker, setShowEmojiPicker, emojiCategory, setEmojiCategory, emojiPickerRef,
    model, setModel, modelTiers,
  } = props;
  const { t } = useTranslation();
  return (
    <div className="flex max-w-4xl flex-col gap-6 animate-fadeIn">
      <SectionHeader title={t('agent_studio.identity_agent_identity', 'Agent Identity')} />

      <SettingsList>
        <SettingRow label={t('agent_studio.identity_avatar', 'Avatar')}>
          <AvatarPicker
            avatar={avatar} setAvatar={setAvatar}
            showEmojiPicker={showEmojiPicker} setShowEmojiPicker={setShowEmojiPicker}
            emojiCategory={emojiCategory} setEmojiCategory={setEmojiCategory} emojiPickerRef={emojiPickerRef}
          />
        </SettingRow>
        <SettingRow htmlFor="agent-name" label={t('agent_studio.identity_name', 'Name')}>
          <input
            id="agent-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={FIELD_INPUT}
            placeholder={t('agent_studio.identity_e_g_data_analyst', 'e.g. Data Analyst')}
          />
        </SettingRow>
        <SettingRow htmlFor="agent-role" label={t('agent_studio.identity_role_description', 'Role Description')}>
          <input
            id="agent-role"
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className={FIELD_INPUT}
            placeholder={t('agent_studio.identity_e_g_analyzes_trends_in_csv_files', 'e.g. Analyzes trends in CSV files')}
          />
        </SettingRow>
        <SettingRow label={t('agent_studio.identity_category', 'Category')}>
          <CategoryControl {...props} />
        </SettingRow>
      </SettingsList>

      <SettingsGroup title={t('agent_studio.identity_intelligence_instructions', 'Intelligence & Instructions')}>
        <SettingsList>
          <SettingBlock label={t('agent_studio.identity_ai_model', 'AI Model')}>
            <ModelTierSelector
              tiers={modelTiers}
              value={model ? model.replace('tier:', '') : 'auto'}
              onChange={(tier) => setModel(`tier:${tier}`)}
            />
          </SettingBlock>
          <SettingBlock
            htmlFor="agent-system-prompt"
            label={t('agent_studio.identity_system_prompt', 'System Prompt')}
            hint={t('agent_studio.identity_defines_personality_and_rules', 'Defines personality and rules')}
          >
            <textarea
              id="agent-system-prompt"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              className={`${FIELD_INPUT} min-h-[200px] font-mono leading-relaxed`}
              rows={12}
              data-tour="agent-system-prompt"
              placeholder={t('agent_studio.identity_you_are_a_helpful_assistant', 'You are a helpful assistant...')}
            />
          </SettingBlock>
        </SettingsList>
      </SettingsGroup>

      {selectedAgent && (
        <VersionHistory agentId={selectedAgent.id} onRestore={() => window.location.reload()} />
      )}
    </div>
  );
};
