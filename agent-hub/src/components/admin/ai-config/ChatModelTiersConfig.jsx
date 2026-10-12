import React from 'react';
import AiStepModelSection from './chatModelTiers/AiStepModelSection';
import ChatTiersSection from './chatModelTiers/ChatTiersSection';
import ClassifierModelSection from './chatModelTiers/ClassifierModelSection';
import ClaudeSettingsSection from './chatModelTiers/ClaudeSettingsSection';
import DataExtractionModelSection from './chatModelTiers/DataExtractionModelSection';
import EuTiersSection from './chatModelTiers/EuTiersSection';
import MemoryExtractionModelSection from './chatModelTiers/MemoryExtractionModelSection';
import TitleModelSection from './chatModelTiers/TitleModelSection';
import useChatModelTiersState from './chatModelTiers/useChatModelTiersState';

const ChatModelTiersConfig = ({ allModels = [] }) => {
    const {
        config, euConfig, customTiers, saving, euSaving, message, euMessage,
        expandedTier, setExpandedTier, expandedCustomId, setExpandedCustomId,
        classifierModel, setClassifierModel, classifierSaving, classifierMessage,
        titleModel, setTitleModel, titleModelSaving, titleModelMessage,
        memoryModel, setMemoryModel, memoryModelSaving, memoryModelMessage, saveMemoryModel,
        aiStepModel, setAiStepModel, aiStepModelSaving, aiStepModelMessage, saveAiStepModel,
        dataExtractionModel, setDataExtractionModel, dataExtractionModelSaving, dataExtractionModelMessage, saveDataExtractionModel,
        hiddenModelIds, claudeAutoRetry, setClaudeAutoRetry, claudeSaving,
        claudeMessage, claudeRecAppliedTier,
        saveClaudeSettings, applyClaudeRecommendedForTier, applyAllClaudeRecommended,
        toggleHiddenModel, saveClassifierModel, saveTitleModel,
        save, saveEu, addCustomTier, updateCustomTier, renameCustomTier,
        removeCustomTier, toggleCustomTaskType,
        chatModels, isLocal, reasoningCapable, updateTier, updateEuTier, byProvider,
        confirmDialog,
    } = useChatModelTiersState(allModels);

    return (
        <div className="space-y-8">
            {/* Regular Chat Model Tiers */}
            <ChatTiersSection
                config={config}
                customTiers={customTiers}
                saving={saving}
                message={message}
                save={save}
                addCustomTier={addCustomTier}
                updateTier={updateTier}
                expandedTier={expandedTier}
                setExpandedTier={setExpandedTier}
                expandedCustomId={expandedCustomId}
                setExpandedCustomId={setExpandedCustomId}
                chatModels={chatModels}
                byProvider={byProvider}
                hiddenModelIds={hiddenModelIds}
                toggleHiddenModel={toggleHiddenModel}
                isLocal={isLocal}
                reasoningCapable={reasoningCapable}
                applyClaudeRecommendedForTier={applyClaudeRecommendedForTier}
                updateCustomTier={updateCustomTier}
                renameCustomTier={renameCustomTier}
                removeCustomTier={removeCustomTier}
                toggleCustomTaskType={toggleCustomTaskType}
            />

            {/* Claude Settings — model-specific recommendations + robustness toggles */}
            <ClaudeSettingsSection
                claudeAutoRetry={claudeAutoRetry}
                setClaudeAutoRetry={setClaudeAutoRetry}
                claudeSaving={claudeSaving}
                claudeMessage={claudeMessage}
                claudeRecAppliedTier={claudeRecAppliedTier}
                saveClaudeSettings={saveClaudeSettings}
                applyClaudeRecommendedForTier={applyClaudeRecommendedForTier}
                applyAllClaudeRecommended={applyAllClaudeRecommended}
            />

            {/* Auto-tier Classifier Model */}
            <ClassifierModelSection
                classifierModel={classifierModel}
                setClassifierModel={setClassifierModel}
                classifierSaving={classifierSaving}
                classifierMessage={classifierMessage}
                saveClassifierModel={saveClassifierModel}
                chatModels={chatModels}
                byProvider={byProvider}
                hiddenModelIds={hiddenModelIds}
                toggleHiddenModel={toggleHiddenModel}
            />

            {/* Title Generation Model */}
            <TitleModelSection
                titleModel={titleModel}
                setTitleModel={setTitleModel}
                titleModelSaving={titleModelSaving}
                titleModelMessage={titleModelMessage}
                saveTitleModel={saveTitleModel}
                chatModels={chatModels}
                byProvider={byProvider}
                hiddenModelIds={hiddenModelIds}
                toggleHiddenModel={toggleHiddenModel}
            />

            {/* Memory Extraction Model */}
            <MemoryExtractionModelSection
                memoryModel={memoryModel}
                setMemoryModel={setMemoryModel}
                memoryModelSaving={memoryModelSaving}
                memoryModelMessage={memoryModelMessage}
                saveMemoryModel={saveMemoryModel}
                chatModels={chatModels}
                byProvider={byProvider}
                hiddenModelIds={hiddenModelIds}
                toggleHiddenModel={toggleHiddenModel}
            />

            {/* AI Step Model — temporary override */}
            <AiStepModelSection
                aiStepModel={aiStepModel}
                setAiStepModel={setAiStepModel}
                aiStepModelSaving={aiStepModelSaving}
                aiStepModelMessage={aiStepModelMessage}
                saveAiStepModel={saveAiStepModel}
                chatModels={chatModels}
                byProvider={byProvider}
                hiddenModelIds={hiddenModelIds}
                toggleHiddenModel={toggleHiddenModel}
            />

            {/* Data Extraction Model — the automation Extract data step's own model */}
            <DataExtractionModelSection
                dataExtractionModel={dataExtractionModel}
                setDataExtractionModel={setDataExtractionModel}
                dataExtractionModelSaving={dataExtractionModelSaving}
                dataExtractionModelMessage={dataExtractionModelMessage}
                saveDataExtractionModel={saveDataExtractionModel}
                chatModels={chatModels}
                byProvider={byProvider}
                hiddenModelIds={hiddenModelIds}
                toggleHiddenModel={toggleHiddenModel}
            />

            {/* EU Chat Model Tiers */}
            <EuTiersSection
                euConfig={euConfig}
                customTiers={customTiers}
                euSaving={euSaving}
                euMessage={euMessage}
                saveEu={saveEu}
                updateEuTier={updateEuTier}
                expandedTier={expandedTier}
                setExpandedTier={setExpandedTier}
                chatModels={chatModels}
                byProvider={byProvider}
                hiddenModelIds={hiddenModelIds}
                toggleHiddenModel={toggleHiddenModel}
                isLocal={isLocal}
                reasoningCapable={reasoningCapable}
                applyClaudeRecommendedForTier={applyClaudeRecommendedForTier}
                updateCustomTier={updateCustomTier}
            />
            {confirmDialog}
        </div>
    );
};

export default ChatModelTiersConfig;
