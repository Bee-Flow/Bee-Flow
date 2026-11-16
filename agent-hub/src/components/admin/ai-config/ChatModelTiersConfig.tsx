// The Models page of AI configuration, top to bottom: the chat tiers, their EU
// models, the custom tiers, the Claude recommendations (only with a Claude
// model), the background models and Reliability. Everything but the two
// switches (hidden models, the retry) is one draft with one save bar.
import BackgroundModelsGroups from './chatModelTiers/BackgroundModelsGroups';
import ChatTiersSection from './chatModelTiers/ChatTiersSection';
import { hasClaudeModels } from './chatModelTiers/claudeRecommendations';
import ClaudeSettingsSection from './chatModelTiers/ClaudeSettingsSection';
import CustomTiersSection from './chatModelTiers/CustomTiersSection';
import EuTiersSection from './chatModelTiers/EuTiersSection';
import ReliabilitySection from './chatModelTiers/ReliabilitySection';
import useChatModelTiersState from './chatModelTiers/useChatModelTiersState';
import type { CatalogModel } from './chatModelTiers/tierTypes';
import SaveBar from '@/components/shared/SaveBar';

interface ChatModelTiersConfigProps {
    allModels?: CatalogModel[];
}

const ChatModelTiersConfig = ({ allModels = [] }: ChatModelTiersConfigProps) => {
    const s = useChatModelTiersState(allModels);
    const picker = { chatModels: s.chatModels, byProvider: s.byProvider, hiddenModelIds: s.hiddenModelIds, toggleHiddenModel: s.toggleHiddenModel };
    const claude = hasClaudeModels(s.chatModels);

    return (
        <div className="flex flex-col gap-8">
            <SaveBar dirty={s.dirty} saving={s.saving} onSave={() => { void s.saveAll(); }} onDiscard={s.discardAll} message={s.saveMessage} />

            <ChatTiersSection
                {...picker}
                config={s.config}
                updateTier={s.updateTier}
                expandedTier={s.expandedTier}
                setExpandedTier={s.setExpandedTier}
                isLocal={s.isLocal}
                reasoningCapable={s.reasoningCapable}
                applyClaudeRecommendedForTier={s.applyClaudeRecommendedForTier}
            />

            <EuTiersSection
                {...picker}
                euConfig={s.euConfig}
                updateEuTier={s.updateEuTier}
                expandedTier={s.expandedEuTier}
                setExpandedTier={s.setExpandedEuTier}
                isLocal={s.isLocal}
                reasoningCapable={s.reasoningCapable}
                applyClaudeRecommendedForTier={s.applyClaudeRecommendedForTier}
            />

            <CustomTiersSection
                {...picker}
                customTiers={s.customTiers}
                addCustomTier={s.addCustomTier}
                expandedCustomId={s.expandedCustomId}
                setExpandedCustomId={s.setExpandedCustomId}
                reasoningCapable={s.reasoningCapable}
                updateCustomTier={s.updateCustomTier}
                renameCustomTier={s.renameCustomTier}
                removeCustomTier={s.removeCustomTier}
                toggleCustomTaskType={s.toggleCustomTaskType}
            />

            {/* Claude models: the recommendations, only when a Claude model is
                configured (via Anthropic, Azure or Vertex). */}
            {claude && (
                <ClaudeSettingsSection
                    claudeMessage={s.claudeMessage}
                    claudeRecAppliedTier={s.claudeRecAppliedTier}
                    applyClaudeRecommendedForTier={s.applyClaudeRecommendedForTier}
                    applyAllClaudeRecommended={s.applyAllClaudeRecommended}
                    chatModels={s.chatModels}
                />
            )}

            <BackgroundModelsGroups
                {...picker}
                classifier={s.classifier}
                title={s.title}
                memory={s.memory}
                aiStep={s.aiStep}
                dataExtraction={s.dataExtraction}
            />

            {/* The empty-answer retry: the server applies it to Claude models only. */}
            {claude && <ReliabilitySection reliability={s.reliability} />}
            {s.confirmDialog}
        </div>
    );
};

export default ChatModelTiersConfig;
