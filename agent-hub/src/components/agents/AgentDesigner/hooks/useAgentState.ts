import { useState, useRef } from 'react';
import { useUrlQueryParam } from '@/hooks/useUrlTab';
import type { ModelTierMap } from '@/api/queries/modelTiers';
import type { ModelEntry } from '@/api/modelMeta';
import type { DesignerAgent } from '../AgentListSidebar';
import type { IntegrationStatus } from '../DesignerPanels';
import type { OrgGroup } from '../PublishMenu';

const VALID_DESIGNER_SECTIONS: (string | null)[] = ['identity', 'tools', 'behavior', 'knowledge'];

/** A tool from `GET /agents/meta/components`. */
export interface DesignerComponent { id: string; name?: string; category?: string }
/** An organisation from `GET /auth/organizations`. */
export interface DesignerOrganization { id: string; name?: string }
/** An agent category from `GET /agents/categories`. */
export interface AgentCategory { id: string; name?: string }
/** A regex-guardrail collection from `GET /ai/config`. */
export interface RegexCollection { id: string; name?: string }
/** Which text the regex guardrails look at. */
export interface RegexScope { userInput: boolean; agentOutput: boolean; toolInput: boolean; toolOutput: boolean }
/** A line of the designer's test chat. */
export interface DesignerMessage { role: string; content: string }

/**
 * All form/UI state for the AgentDesigner.
 * Returns a flat object of [value, setter] pairs grouped by concern.
 */
export default function useAgentState() {
    // Core
    const [agents, setAgents] = useState<DesignerAgent[]>([]);
    const [selectedAgent, setSelectedAgent] = useState<DesignerAgent | null>(null);
    const [isCreating, setIsCreating] = useState(false);
    const [components, setComponents] = useState<DesignerComponent[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    // Form
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [systemPrompt, setSystemPrompt] = useState('');
    const [selectedTools, setSelectedTools] = useState<string[]>([]);
    const [toolParams, setToolParams] = useState<Record<string, unknown>>({});
    const [model, setModel] = useState('');
    const [isPublished, setIsPublished] = useState(false);
    const [sharedGroups, setSharedGroups] = useState<string[]>([]);
    const [showPublishMenu, setShowPublishMenu] = useState(false);
    const [publishError, setPublishError] = useState('');
    const [organizations, setOrganizations] = useState<DesignerOrganization[]>([]);
    const [orgGroups, setOrgGroups] = useState<OrgGroup[]>([]);
    const [availableModels, setAvailableModels] = useState<ModelEntry[]>([]);
    const [modelTiers, setModelTiers] = useState<ModelTierMap>({});
    const [starterPrompts, setStarterPrompts] = useState<string[]>([]);
    const [avatar, setAvatar] = useState('\u{1F916}');
    const [showEmojiPicker, setShowEmojiPicker] = useState(false);
    const [emojiCategory, setEmojiCategory] = useState('smileys');

    // Categories
    const [categoryId, setCategoryId] = useState<string | null>(null);
    const [agentCategories, setAgentCategories] = useState<AgentCategory[]>([]);

    // Behavior
    const [allowCopy, setAllowCopy] = useState(true);
    const [embedEnabled, setEmbedEnabled] = useState(false);
    const [workspaceEnabled, setWorkspaceEnabled] = useState(false);
    const [enableGuardrails, setEnableGuardrails] = useState(false);
    const [llamaGuardEnabled, setLlamaGuardEnabled] = useState(false);
    const [webSearchGuardEnabled, setWebSearchGuardEnabled] = useState(false);
    const [disableExternalTools, setDisableExternalTools] = useState(false);

    const [strictKnowledge, setStrictKnowledge] = useState(false);
    const [includeSourceReferences, setIncludeSourceReferences] = useState(false);
    const [knowledgeBaseIds, setKnowledgeBaseIds] = useState<string[]>([]);

    // Regex Guardrails
    const [regexGuardrailsEnabled, setRegexGuardrailsEnabled] = useState(false);
    const [selectedCollections, setSelectedCollections] = useState<string[]>([]);
    const [availableCollections, setAvailableCollections] = useState<RegexCollection[]>([]);
    const [regexScope, setRegexScope] = useState<RegexScope>({
        userInput: true,
        agentOutput: true,
        toolInput: false,
        toolOutput: false
    });
    const [guardrailAction, setGuardrailAction] = useState('delete');

    // Bubble widget styling
    const [bubbleColor, setBubbleColor] = useState('#f5a623');
    const [bubblePosition, setBubblePosition] = useState('right');
    const [bubbleSize, setBubbleSize] = useState(60);
    const [bubbleIcon, setBubbleIcon] = useState('🐝');
    const [windowWidth, setWindowWidth] = useState(400);
    const [windowHeight, setWindowHeight] = useState(600);
    const [chatFont, setChatFont] = useState('System Default');
    const [chatFontSize, setChatFontSize] = useState(14);
    const [chatLineHeight, setChatLineHeight] = useState(1.5);
    const [userBubbleColor, setUserBubbleColor] = useState('');
    const [assistantBubbleColor, setAssistantBubbleColor] = useState('');
    const [warningText, setWarningText] = useState('');

    // Navigation — mirrored to the ?section= query param so the active
    // sub-section of the Agent Designer is bookmarkable.
    const [sectionParam, setSectionParam] = useUrlQueryParam('section');
    const activeSection = VALID_DESIGNER_SECTIONS.includes(sectionParam) ? sectionParam : 'identity';
    const setActiveSection = (v: string) => setSectionParam(VALID_DESIGNER_SECTIONS.includes(v) ? v : 'identity');
    const [activeGuardrailTab, setActiveGuardrailTab] = useState('llama');
    const [showPreview, setShowPreview] = useState(false);

    // Chat
    const [messages, setMessages] = useState<DesignerMessage[]>([]);
    const [chatInput, setChatInput] = useState('');
    const [chatLoading, setChatLoading] = useState(false);
    const [showChat, setShowChat] = useState(false);
    const [showToolSelector, setShowToolSelector] = useState(false);
    const [integrationStatus, setIntegrationStatus] = useState<IntegrationStatus | null>(null);
    const [enabledIntegrations, setEnabledIntegrations] = useState<string[] | null>(null);

    // Prompt Designer
    const [showPromptDesigner, setShowPromptDesigner] = useState(false);
    const [promptDesignerMessages, setPromptDesignerMessages] = useState<DesignerMessage[]>([]);
    const [promptDesignerInput, setPromptDesignerInput] = useState('');
    const [promptDesignerLoading, setPromptDesignerLoading] = useState(false);

    // Refs
    const chatEndRef = useRef<HTMLDivElement>(null);
    const emojiPickerRef = useRef<HTMLDivElement>(null);

    return {
        // Core
        agents, setAgents, selectedAgent, setSelectedAgent,
        isCreating, setIsCreating, components, setComponents,
        loading, setLoading, saving, setSaving,
        // Form
        name, setName, description, setDescription,
        systemPrompt, setSystemPrompt, selectedTools, setSelectedTools,
        toolParams, setToolParams, model, setModel,
        isPublished, setIsPublished, sharedGroups, setSharedGroups,
        showPublishMenu, setShowPublishMenu, publishError, setPublishError,
        organizations, setOrganizations,
        orgGroups, setOrgGroups, availableModels, setAvailableModels,
        modelTiers, setModelTiers, starterPrompts, setStarterPrompts,
        avatar, setAvatar, showEmojiPicker, setShowEmojiPicker,
        emojiCategory, setEmojiCategory,
        categoryId, setCategoryId, agentCategories, setAgentCategories,
        // Behavior
        allowCopy, setAllowCopy, embedEnabled, setEmbedEnabled,
        workspaceEnabled, setWorkspaceEnabled, enableGuardrails, setEnableGuardrails,
        llamaGuardEnabled, setLlamaGuardEnabled, webSearchGuardEnabled, setWebSearchGuardEnabled,
        disableExternalTools, setDisableExternalTools,

        strictKnowledge, setStrictKnowledge,
        includeSourceReferences, setIncludeSourceReferences,
        knowledgeBaseIds, setKnowledgeBaseIds,
        // Regex Guardrails
        regexGuardrailsEnabled, setRegexGuardrailsEnabled,
        selectedCollections, setSelectedCollections,
        availableCollections, setAvailableCollections,
        regexScope, setRegexScope, guardrailAction, setGuardrailAction,
        // Bubble Widget
        bubbleColor, setBubbleColor, bubblePosition, setBubblePosition,
        bubbleSize, setBubbleSize, bubbleIcon, setBubbleIcon,
        windowWidth, setWindowWidth, windowHeight, setWindowHeight,
        chatFont, setChatFont, chatFontSize, setChatFontSize,
        chatLineHeight, setChatLineHeight,
        userBubbleColor, setUserBubbleColor,
        assistantBubbleColor, setAssistantBubbleColor,
        warningText, setWarningText,
        // Navigation
        activeSection, setActiveSection, activeGuardrailTab, setActiveGuardrailTab,
        showPreview, setShowPreview,
        // Chat
        messages, setMessages, chatInput, setChatInput,
        chatLoading, setChatLoading, showChat, setShowChat,
        showToolSelector, setShowToolSelector,
        integrationStatus, setIntegrationStatus,
        enabledIntegrations, setEnabledIntegrations,
        // Prompt Designer
        showPromptDesigner, setShowPromptDesigner,
        promptDesignerMessages, setPromptDesignerMessages,
        promptDesignerInput, setPromptDesignerInput,
        promptDesignerLoading, setPromptDesignerLoading,
        // Refs
        chatEndRef, emojiPickerRef,
    };
}
