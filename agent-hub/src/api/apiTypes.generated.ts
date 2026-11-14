// GENERATED from docs/static/openapi.json by scripts/gen-api-types.mjs, do not edit.
// After a route or schema change: npm run gen:api-reference, then npm run gen:api-types.
//
// One member per server operation, keyed '<METHOD> <path template>'. `params` are the
// path parameters, `query` and `body` the zod schemas of the route's validate(); a route
// that declares none reads them by hand, so they stay loose. The spec describes no
// responses: `response` is unknown and the caller states what it reads.

/** The query of a route that declares no query schema. */
type UndeclaredQuery = Record<string, string | number | boolean | null | undefined>;
/** The path parameters of a route without any. */
export type NoParams = Record<string, never>;

/** One operation: its path parameters, query and request body; the response is not described. */
interface Op<P = NoParams, Q = UndeclaredQuery, B = unknown> {
    params: P;
    query: Q;
    body: B;
    response: unknown;
}

/** 1911 operations. */
export interface ApiOperations {
    'GET /.well-known/microsoft-identity-association.json': Op;
    'GET /.well-known/security.txt': Op;
    'GET /agents': Op;
    'POST /agents': Op;
    'GET /agents/all': Op<NoParams, {
        orgId?: string;
        t?: string;
        usage?: '0' | '1' | 'true' | 'false';
    }>;
    'GET /agents/categories': Op;
    'POST /agents/categories': Op<NoParams, UndeclaredQuery, {
        color?: string | null;
        icon?: string;
        name: string;
    }>;
    'PATCH /agents/categories/{id}': Op<{ id: string | number }, UndeclaredQuery, {
        color?: string | null;
        icon?: string;
        name?: string;
    }>;
    'DELETE /agents/categories/{id}': Op<{ id: string | number }, {
        reassignTo?: string;
    }>;
    'GET /agents/conversations/all': Op;
    'GET /agents/conversations/search': Op<NoParams, {
        agentId?: string;
        endDate?: string;
        limit?: number;
        offset?: number;
        q?: string;
        source?: 'agent' | 'direct';
        startDate?: string;
    }>;
    'POST /agents/describe-building': Op<NoParams, UndeclaredQuery, {
        code: string;
    }>;
    'GET /agents/favorites': Op;
    'POST /agents/favorites/bulk': Op<NoParams, UndeclaredQuery, {
        agentIds: Array<string>;
    }>;
    'GET /agents/memory': Op<NoParams, {
        ids: string;
    }>;
    'POST /agents/memory': Op<NoParams, UndeclaredQuery, {
        agentId?: string | null;
        content: string;
        importance?: number | null;
        projectId?: string | null;
        summary?: string | null;
        type?: 'instruction' | 'person' | 'project' | 'preference' | 'workflow' | 'fact' | 'context' | null;
    }>;
    'POST /agents/memory/bulk-delete': Op<NoParams, UndeclaredQuery, {
        ids: Array<string>;
    }>;
    'POST /agents/memory/bulk-update': Op<NoParams, UndeclaredQuery, {
        ids: Array<string>;
        type: 'instruction' | 'person' | 'project' | 'preference' | 'workflow' | 'fact' | 'context';
    }>;
    'DELETE /agents/memory/by-conversation/{conversationId}': Op<{ conversationId: string | number }>;
    'POST /agents/memory/clear': Op<NoParams, UndeclaredQuery, {
        projectId?: string;
    }>;
    'GET /agents/memory/export/all': Op;
    'POST /agents/memory/import': Op<NoParams, UndeclaredQuery, {
        text: string;
    }>;
    'GET /agents/memory/recent': Op<NoParams, {
        conversationId: string;
        since: string;
    }>;
    'GET /agents/memory/review': Op<NoParams, {
        limit?: string;
        offset?: string;
    }>;
    'POST /agents/memory/review/{id}/approve': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /agents/memory/review/{id}/reject': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /agents/memory/stats': Op;
    'GET /agents/memory/types': Op;
    'GET /agents/memory/{id}': Op<{ id: string | number }>;
    'PUT /agents/memory/{id}': Op<{ id: string | number }, UndeclaredQuery, {
        content?: string | null;
        importance?: number | null;
        summary?: string | null;
        type?: 'instruction' | 'person' | 'project' | 'preference' | 'workflow' | 'fact' | 'context' | null;
    }>;
    'DELETE /agents/memory/{id}': Op<{ id: string | number }, {
        undo?: '1';
    }>;
    'POST /agents/memory/{id}/restore': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /agents/meta/components': Op;
    'GET /agents/meta/models': Op;
    'GET /agents/published': Op<NoParams, {
        t?: string;
        usage?: '0' | '1' | 'true' | 'false';
    }>;
    'GET /agents/system': Op;
    'POST /agents/system/conversation-starters/generate': Op<NoParams, UndeclaredQuery, {
        agentDescription?: string | null;
        agentName?: string | null;
        systemPrompt?: string | null;
    }>;
    'POST /agents/system/description-improver/generate': Op<NoParams, UndeclaredQuery, {
        agentName?: string | null;
        currentDescription?: string | null;
        systemPrompt?: string | null;
    }>;
    'POST /agents/system/identity-improver/generate': Op<NoParams, UndeclaredQuery, {
        currentDescription?: string | null;
        currentName?: string | null;
        systemPrompt: string;
    }>;
    'POST /agents/system/prompt-designer/stream': Op<NoParams, UndeclaredQuery, {
        message: string;
    }>;
    'POST /agents/thread/title': Op<NoParams, UndeclaredQuery, {
        content: string;
    }>;
    'GET /agents/tool-catalog': Op;
    'POST /agents/wizard/commit': Op<NoParams, UndeclaredQuery, {
        locale?: string | null;
        plan: Record<string, unknown>;
    }>;
    'POST /agents/wizard/draft': Op<NoParams, UndeclaredQuery, {
        locale?: string | null;
        modelTier?: string | null;
        prompt: string;
    }>;
    'POST /agents/wizard/refine': Op<NoParams, UndeclaredQuery, {
        current?: Record<string, unknown> | null;
        locale?: string | null;
        modelTier?: string | null;
        plan: Record<string, unknown>;
        prompt?: string | null;
        refinement: string;
    }>;
    'GET /agents/{id}': Op<{ id: string | number }>;
    'PUT /agents/{id}': Op<{ id: string | number }, UndeclaredQuery, {
        avatar?: string | null;
        baseVersion?: number | null;
        categoryId?: string | null;
        config?: unknown;
        copyEnabled?: boolean;
        description?: string | null;
        embedEnabled?: boolean;
        model?: string | null;
        name?: string | null;
        organizationId?: unknown;
        persona?: unknown;
        sharedGroups?: unknown;
        starterPrompts?: Array<string>;
        systemPrompt?: string | null;
        threadsEnabled?: boolean;
        toolParams?: unknown;
        tools?: Array<string> | null;
        workspaceEnabled?: boolean;
    }>;
    'DELETE /agents/{id}': Op<{ id: string | number }>;
    'POST /agents/{id}/chat': Op<{ id: string | number }, UndeclaredQuery, {
        message: string;
    }>;
    'POST /agents/{id}/chat/stream': Op<{ id: string | number }, UndeclaredQuery, {
        activeSkillIds?: Array<string>;
        agentId?: unknown;
        asGroup?: unknown;
        attachments?: Array<unknown>;
        chatSignalsNotice?: string;
        chatSignalsOptOut?: boolean;
        conversationId?: string | null;
        ephemeral?: boolean;
        history?: Array<{
            content?: string | Array<unknown> | null;
            [key: string]: unknown;
        }>;
        incognito?: boolean;
        isHidden?: unknown;
        memoryReadEnabled?: boolean;
        memoryWriteEnabled?: boolean;
        message: string;
        messageId?: string | null;
        modelTier?: string;
        notebookspaceAvailable?: boolean;
        notebookspaceContent?: string;
        notebookspaceSelection?: string;
        parentId?: string | null;
        projectId?: string | null;
        reasoningEffort?: string;
        sidePanelDocument?: unknown;
        sidePanelWebpage?: Record<string, unknown> | null;
        stream?: unknown;
        test?: boolean;
        testSessionId?: string;
        timezone?: string;
        toolDecisions?: Array<Record<string, unknown>>;
        webSearchEnabled?: boolean;
    }>;
    'GET /agents/{id}/conversations': Op<{ id: string | number }>;
    'POST /agents/{id}/conversations': Op<{ id: string | number }, UndeclaredQuery, {
        title?: string;
    }>;
    'GET /agents/{id}/conversations/{convId}': Op<{ id: string | number; convId: string | number }>;
    'PATCH /agents/{id}/conversations/{convId}': Op<{ id: string | number; convId: string | number }, UndeclaredQuery, {
        labels?: Array<string>;
        pinned?: boolean;
        title?: string;
    }>;
    'DELETE /agents/{id}/conversations/{convId}': Op<{ id: string | number; convId: string | number }>;
    'PATCH /agents/{id}/conversations/{convId}/thread-titles': Op<{ id: string | number; convId: string | number }, UndeclaredQuery, {
        threadTitles: Record<string, string>;
    }>;
    'GET /agents/{id}/conversations/{convId}/workspace': Op<{ id: string | number; convId: string | number }>;
    'PUT /agents/{id}/conversations/{convId}/workspace': Op<{ id: string | number; convId: string | number }, UndeclaredQuery, {
        content?: string | null;
        notebookId?: string | null;
    }>;
    'GET /agents/{id}/embed': Op<{ id: string | number }>;
    'PUT /agents/{id}/favorite': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'DELETE /agents/{id}/favorite': Op<{ id: string | number }>;
    'GET /agents/{id}/history': Op<{ id: string | number }>;
    'DELETE /agents/{id}/history': Op<{ id: string | number }>;
    'POST /agents/{id}/persona/parse': Op<{ id: string | number }, UndeclaredQuery, {
        text?: string | null;
    }>;
    'PATCH /agents/{id}/publish': Op<{ id: string | number }, UndeclaredQuery, {
        isPublished?: boolean;
        sharedGroups?: Array<string> | null;
    }>;
    'POST /agents/{id}/publish-version': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /agents/{id}/tests': Op<{ id: string | number }>;
    'POST /agents/{id}/tests': Op<{ id: string | number }, UndeclaredQuery, {
        expect?: {
            mustMention?: Array<string>;
            mustNotMention?: Array<string>;
            notes?: string | null;
            rulesExpected?: Array<string>;
            toolsExpected?: Array<string>;
        } | null;
        fromConversationId?: string | null;
        name?: string | null;
        question: string;
        suggestedBy?: string | null;
        writtenBy?: {
            mustMention?: 'ai' | 'observed' | 'human' | 'empty';
            mustNotMention?: 'ai' | 'observed' | 'human' | 'empty';
            notes?: 'ai' | 'observed' | 'human' | 'empty';
            rulesExpected?: 'ai' | 'observed' | 'human' | 'empty';
            toolsExpected?: 'ai' | 'observed' | 'human' | 'empty';
        } | null;
    }>;
    'POST /agents/{id}/tests/run': Op<{ id: string | number }, UndeclaredQuery, {
        asGroup?: unknown;
        testIds?: Array<string>;
        timezone?: string | null;
    }>;
    'GET /agents/{id}/tests/runs': Op<{ id: string | number }, {
        limit?: number;
    }>;
    'POST /agents/{id}/tests/suggest': Op<{ id: string | number }, UndeclaredQuery, {
        answer?: string;
        question?: string;
        toolsUsed?: Array<unknown>;
    }>;
    'PUT /agents/{id}/tests/{testId}': Op<{ id: string | number; testId: string | number }, UndeclaredQuery, {
        expect?: {
            mustMention?: Array<string>;
            mustNotMention?: Array<string>;
            notes?: string | null;
            rulesExpected?: Array<string>;
            toolsExpected?: Array<string>;
        } | null;
        name?: string | null;
        question?: string;
    }>;
    'DELETE /agents/{id}/tests/{testId}': Op<{ id: string | number; testId: string | number }>;
    'GET /agents/{id}/tool-lending': Op<{ id: string | number }>;
    'GET /agents/{id}/tools': Op<{ id: string | number }>;
    'PUT /agents/{id}/tools/{componentId}/params': Op<{ id: string | number; componentId: string | number }, UndeclaredQuery, {
        params?: Record<string, unknown> | null;
    }>;
    'PUT /agents/{id}/transfer': Op<{ id: string | number }, UndeclaredQuery, {
        newOwnerId: string;
    }>;
    'GET /agents/{id}/usage': Op<{ id: string | number }>;
    'GET /ai/agent-search/defaults': Op;
    'PUT /ai/agent-search/defaults': Op<NoParams, UndeclaredQuery, {
        include_citations?: boolean;
        mode?: 'web' | 'web_fast' | 'kb' | 'auto';
        web?: {
            detail_level?: 'basic' | 'detailed' | 'highly_detailed';
            fetch_top_n?: number | string;
            max_results?: number | string;
            max_tokens_markdown?: number | string;
        };
        web_fast?: {
            detail_level?: 'basic' | 'detailed' | 'highly_detailed';
            max_results?: number | string;
            max_tokens_markdown?: number | string;
        };
    }>;
    'POST /ai/chat/direct/stream': Op<NoParams, UndeclaredQuery, {
        activatedSessionSkillIds?: Array<unknown> | null;
        activeSkillIds?: Array<unknown> | null;
        attachments?: Array<Record<string, unknown>> | null;
        chatSignalsNotice?: string | null;
        chatSignalsOptOut?: boolean | null;
        conversationId?: string | null;
        disabledMedia?: Record<string, unknown> | null;
        history?: Array<unknown> | null;
        imageGenSettings?: Record<string, unknown> | null;
        incognito?: boolean | null;
        knowledgeBaseIds?: Array<unknown> | null;
        memoryReadEnabled?: boolean | null;
        memoryWriteEnabled?: boolean | null;
        message?: string | null;
        modelTier?: string | null;
        nanoBananaSettings?: Record<string, unknown> | null;
        notebookspaceAvailable?: boolean | null;
        notebookspaceContent?: string | null;
        notebookspaceSelection?: string | null;
        projectId?: string | null;
        reasoningEffort?: string | null;
        sidePanelDocument?: unknown;
        systemPrompt?: string | null;
        timezone?: string | null;
        webSearchEnabled?: boolean | null;
        [key: string]: unknown;
    }>;
    'POST /ai/chat/generate-image': Op<NoParams, UndeclaredQuery, {
        aspectRatio?: string;
        conversationId?: string | null;
        prompt: string;
    }>;
    'POST /ai/chat/notebook/stream': Op<NoParams, UndeclaredQuery, {
        attachments?: Array<Record<string, unknown>> | null;
        conversationId?: string | null;
        disabledMedia?: Record<string, unknown> | null;
        docVersion?: number | null;
        documentContent?: string | null;
        history?: Array<unknown> | null;
        memoryReadEnabled?: boolean | null;
        memoryWriteEnabled?: boolean | null;
        message?: string | null;
        modelTier?: string | null;
        notebookId?: string | null;
        notebookSelection?: {
            action?: 'rewrite' | 'shorten' | 'expand' | 'ask' | null;
            from?: number | null;
            text: string;
            to?: number | null;
        } | null;
        reasoningEffort?: string | null;
        timezone?: string | null;
        webSearchEnabled?: boolean | null;
        [key: string]: unknown;
    }>;
    'GET /ai/chat/template/meeting-notes': Op;
    'POST /ai/chat/template/stream': Op<NoParams, UndeclaredQuery, {
        activeSkillIds?: unknown;
        attachments?: Array<{
            content?: string | null;
            name?: string | null;
            source?: string | null;
            type?: string | null;
            [key: string]: unknown;
        }>;
        conversationId?: string | null;
        disabledMedia?: unknown;
        history?: Array<{
            attachments?: Array<unknown>;
            content: string;
            role: 'user' | 'assistant';
        }>;
        imageGenSettings?: unknown;
        meetingNoteIds?: Array<string>;
        memoryReadEnabled?: unknown;
        memoryWriteEnabled?: unknown;
        message: string;
        modelTier?: string;
        nanoBananaSettings?: unknown;
        projectId?: unknown;
        reasoningEffort?: unknown;
        templateId: string;
        timezone?: string;
        webSearchEnabled?: unknown;
    }>;
    'POST /ai/chat/webpage/stream': Op<NoParams, UndeclaredQuery, {
        attachments?: Array<Record<string, unknown>> | null;
        chatMode?: 'ask' | 'auto' | 'plan' | null;
        conversationId?: string | null;
        cssContent?: string | null;
        disabledMedia?: Record<string, unknown> | null;
        history?: Array<unknown> | null;
        htmlContent?: string | null;
        jsContent?: string | null;
        memoryReadEnabled?: boolean | null;
        memoryWriteEnabled?: boolean | null;
        message?: string | null;
        modelTier?: string | null;
        planExecution?: unknown;
        reasoningEffort?: string | null;
        timezone?: string | null;
        webSearchEnabled?: boolean | null;
        webpageId?: string | null;
        webpageSelection?: unknown;
        [key: string]: unknown;
    }>;
    'GET /ai/config': Op;
    'POST /ai/config': Op<NoParams, UndeclaredQuery, {
        agentSearchUrl?: string | null;
        allowedModelsByAgentType?: unknown;
        apiKey?: string | null;
        askAiEnabled?: boolean | null;
        azureApiKey?: string | null;
        azureApiVersion?: string | null;
        azureDocIntelligenceEndpoint?: string | null;
        azureDocIntelligenceKey?: string | null;
        azureEndpoint?: string | null;
        azureImageModels?: Array<{
            deployment: string;
            model?: string;
            pricePerImage?: number | null;
        }>;
        azureModels?: unknown;
        azureOpenaiEmbeddingEndpoint?: string | null;
        azureOpenaiEmbeddingKey?: string | null;
        azureOpenaiEmbeddingModel?: string | null;
        azureRerankerEndpoint?: string | null;
        azureRerankerKey?: string | null;
        azureRerankerModel?: string | null;
        azureSpeechKey?: string | null;
        azureSpeechRegion?: string | null;
        bingSearchKey?: string | null;
        bingSearchMarket?: string | null;
        claudeApiKey?: string | null;
        cpuRerankerEnabled?: boolean | null;
        directChatRegexGuardrails?: unknown;
        elevenlabsApiKey?: string | null;
        embeddingModel?: string | null;
        embeddingProviderId?: string | null;
        eugptApiKey?: string | null;
        exportEnabled?: boolean | null;
        googleApiKey?: string | null;
        googleMapsApiKey?: string | null;
        googleVertexLocation?: string | null;
        googleVertexProject?: string | null;
        googleVertexServiceAccountKey?: string | null;
        ionosApiKey?: string | null;
        kbProvider?: string | null;
        lakeraApiKey?: string | null;
        linkedinClientId?: string | null;
        linkedinClientSecret?: string | null;
        localWhisperEnabled?: boolean | null;
        maxToolRoundsChat?: unknown;
        mistralApiKey?: string | null;
        model?: string | null;
        notebooksEnabled?: boolean | null;
        notebooksMenuEnabled?: boolean | null;
        openInNotebookEnabled?: boolean | null;
        openaiApiKey?: string | null;
        piiDetectionAction?: string | null;
        piiDetectionCategories?: unknown;
        piiDetectionConfidenceThreshold?: unknown;
        piiDetectionEnabled?: boolean | null;
        piiDetectionScope?: unknown;
        projectsEnabled?: boolean | null;
        pyannoteApiKey?: string | null;
        pyannoteIdentifyThreshold?: unknown;
        pyannoteTranscriptionModel?: string | null;
        regexGuardrails?: unknown;
        rerankModel?: string | null;
        rerankProviderId?: string | null;
        scalewayApiKey?: string | null;
        scalewayModel?: string | null;
        scalewayUrl?: string | null;
        searchProvider?: string | null;
        serperApiKey?: string | null;
        serviceEmailDisplayName?: string | null;
        stripeEnabled?: boolean | null;
        stripePublishableKey?: string | null;
        stripeSecretKey?: string | null;
        stripeTaxCountry?: string | null;
        stripeTaxEnabled?: boolean | null;
        stripeWebhookSecret?: string | null;
        subscriptionNotifyEmail?: string | null;
        transcriptionProvider?: string | null;
        url?: string | null;
        useAzureDocProcessing?: boolean | null;
        voiceprintMatchingEnabled?: boolean | null;
        whisperxToken?: string | null;
        whisperxUrl?: string | null;
        withingsClientId?: string | null;
        withingsClientSecret?: string | null;
    }>;
    'GET /ai/config/ai-step-model': Op;
    'POST /ai/config/ai-step-model': Op<NoParams, UndeclaredQuery, {
        modelId?: string | null;
    }>;
    'GET /ai/config/auto-classifier': Op;
    'POST /ai/config/auto-classifier': Op<NoParams, UndeclaredQuery, {
        modelId?: string | null;
    }>;
    'GET /ai/config/builder-narration-model': Op;
    'POST /ai/config/builder-narration-model': Op<NoParams, UndeclaredQuery, {
        modelId?: string | null;
    }>;
    'GET /ai/config/chat-models': Op;
    'POST /ai/config/chat-models': Op<NoParams, UndeclaredQuery, {
        fast?: {
            modelId?: string;
            [key: string]: unknown;
        } | null;
        pro?: {
            modelId?: string;
            [key: string]: unknown;
        } | null;
        smart?: unknown;
        standard?: {
            modelId?: string;
            [key: string]: unknown;
        } | null;
        swarm?: {
            modelId?: string;
            [key: string]: unknown;
        } | null;
        thinking?: {
            modelId?: string;
            [key: string]: unknown;
        } | null;
        writer?: {
            modelId?: string;
            [key: string]: unknown;
        } | null;
    }>;
    'GET /ai/config/chat-models-eu': Op;
    'POST /ai/config/chat-models-eu': Op<NoParams, UndeclaredQuery, {
        fast?: {
            modelId?: string;
            [key: string]: unknown;
        } | null;
        pro?: {
            modelId?: string;
            [key: string]: unknown;
        } | null;
        smart?: unknown;
        standard?: {
            modelId?: string;
            [key: string]: unknown;
        } | null;
        swarm?: {
            modelId?: string;
            [key: string]: unknown;
        } | null;
        thinking?: {
            modelId?: string;
            [key: string]: unknown;
        } | null;
        writer?: {
            modelId?: string;
            [key: string]: unknown;
        } | null;
    }>;
    'GET /ai/config/claude-settings': Op;
    'POST /ai/config/claude-settings': Op<NoParams, UndeclaredQuery, {
        autoRetryOnEmpty?: boolean;
    }>;
    'GET /ai/config/custom-chat-models': Op;
    'POST /ai/config/custom-chat-models': Op<NoParams, UndeclaredQuery, {
        tiers: Array<unknown>;
    }>;
    'GET /ai/config/custom-tiers-list': Op;
    'GET /ai/config/data-extraction-model': Op;
    'POST /ai/config/data-extraction-model': Op<NoParams, UndeclaredQuery, {
        modelId?: string | null;
    }>;
    'GET /ai/config/direct-chat': Op;
    'POST /ai/config/direct-chat': Op<NoParams, UndeclaredQuery, {
        systemPrompt: string;
    }>;
    'GET /ai/config/direct-chat-tool-params': Op;
    'POST /ai/config/direct-chat-tool-params': Op<NoParams, UndeclaredQuery, Record<string, Record<string, Record<string, unknown>>>>;
    'GET /ai/config/direct-chat-tools': Op;
    'POST /ai/config/direct-chat-tools': Op<NoParams, UndeclaredQuery, Record<string, Array<string>>>;
    'GET /ai/config/hidden-models': Op;
    'POST /ai/config/hidden-models': Op<NoParams, UndeclaredQuery, {
        modelIds: Array<string>;
    }>;
    'DELETE /ai/config/key/{keyName}': Op<{ keyName: string | number }>;
    'GET /ai/config/memory-extraction-model': Op;
    'POST /ai/config/memory-extraction-model': Op<NoParams, UndeclaredQuery, {
        modelId?: string | null;
    }>;
    'GET /ai/config/org-custom-chat-models': Op;
    'POST /ai/config/org-custom-chat-models': Op<NoParams, UndeclaredQuery, {
        orgId?: string;
        tiers: Array<unknown>;
    }>;
    'POST /ai/config/service-email/disconnect': Op<NoParams, UndeclaredQuery, Record<string, never>>;
    'GET /ai/config/service-email/oauth/start': Op;
    'DELETE /ai/config/setting/{keyName}': Op<{ keyName: string | number }>;
    'POST /ai/config/test-reranker': Op<NoParams, UndeclaredQuery, Record<string, never>>;
    'POST /ai/config/test-service-email': Op<NoParams, UndeclaredQuery, {
        testRecipient: string;
    }>;
    'GET /ai/config/tiers-for-user': Op;
    'GET /ai/config/title-model': Op;
    'POST /ai/config/title-model': Op<NoParams, UndeclaredQuery, {
        modelId?: string | null;
    }>;
    'GET /ai/config/web-search-inference': Op;
    'POST /ai/config/web-search-inference': Op<NoParams, UndeclaredQuery, {
        cleanup: {
            modelId?: string;
            providerId?: string;
        };
        embed: {
            modelId?: string;
            providerId?: string;
        };
        rerank: {
            method: 'cosine' | 'cpu' | 'provider' | 'local' | 'disabled';
            modelId?: string;
            providerId?: string;
        };
    }>;
    'GET /ai/config/web-search-inference/effective': Op;
    'GET /ai/direct/conversations': Op;
    'GET /ai/direct/conversations/{id}': Op<{ id: string | number }>;
    'PATCH /ai/direct/conversations/{id}': Op<{ id: string | number }, UndeclaredQuery, {
        knowledgeBaseIds?: Array<string>;
        labels?: Array<string>;
        pinned?: boolean;
        title?: string;
    }>;
    'DELETE /ai/direct/conversations/{id}': Op<{ id: string | number }>;
    'GET /ai/direct/conversations/{id}/session-skills': Op<{ id: string | number }>;
    'POST /ai/direct/conversations/{id}/session-skills/regenerate': Op<{ id: string | number }, UndeclaredQuery, {
        message?: string;
        timezone?: string;
    }>;
    'DELETE /ai/direct/conversations/{id}/session-skills/{skillId}': Op<{ id: string | number; skillId: string | number }>;
    'POST /ai/direct/conversations/{id}/session-skills/{skillId}/import': Op<{ id: string | number; skillId: string | number }, UndeclaredQuery, {
        dynamicActivation?: boolean;
        isShared?: boolean;
        name?: string;
    }>;
    'GET /ai/direct/conversations/{id}/workspace': Op<{ id: string | number }>;
    'PUT /ai/direct/conversations/{id}/workspace': Op<{ id: string | number }, UndeclaredQuery, {
        content?: string;
        notebookId?: string | null;
    }>;
    'POST /ai/firebird/test': Op<NoParams, UndeclaredQuery, {
        firebirdCharset?: string | null;
        firebirdDatabase?: string | null;
        firebirdHost?: string | null;
        firebirdPassword?: string | null;
        firebirdPort?: string | null;
        firebirdUser?: string | null;
    }>;
    'POST /ai/frappe-crm/test': Op<NoParams, UndeclaredQuery, {
        frappeCrmApiKey?: string | null;
        frappeCrmApiSecret?: string | null;
        frappeCrmUrl?: string | null;
    }>;
    'POST /ai/generate-regex': Op<NoParams, UndeclaredQuery, {
        modelTier?: string;
        prompt: string;
    }>;
    'GET /ai/labels': Op;
    'POST /ai/labels': Op<NoParams, UndeclaredQuery, {
        color?: string;
        name: string;
    }>;
    'PATCH /ai/labels/{id}': Op<{ id: string | number }, UndeclaredQuery, {
        color?: string;
        name?: string;
    }>;
    'DELETE /ai/labels/{id}': Op<{ id: string | number }>;
    'GET /ai/learning/achievements': Op;
    'GET /ai/learning/admin/courses': Op;
    'POST /ai/learning/admin/courses': Op<NoParams, UndeclaredQuery, {
        badgeIcon?: string;
        badgeTitle?: string;
        desc?: string;
        icon?: string;
        lessonIds?: Array<string>;
        level?: 'beginner' | 'intermediate' | 'advanced';
        title: string;
    }>;
    'GET /ai/learning/admin/courses/{courseId}': Op<{ courseId: string | number }>;
    'PUT /ai/learning/admin/courses/{courseId}': Op<{ courseId: string | number }, UndeclaredQuery, {
        badgeIcon: string;
        badgeTitle: string;
        desc: string;
        icon: string;
        lessonIds: Array<string>;
        level: 'beginner' | 'intermediate' | 'advanced';
        title: string;
    }>;
    'DELETE /ai/learning/admin/courses/{courseId}': Op<{ courseId: string | number }>;
    'POST /ai/learning/admin/courses/{courseId}/publish': Op<{ courseId: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /ai/learning/admin/courses/{courseId}/unpublish': Op<{ courseId: string | number }, UndeclaredQuery, Record<string, never>>;
    'PUT /ai/learning/admin/lessons/{lessonId}': Op<{ lessonId: string | number }, UndeclaredQuery, {
        desc: string;
        estMinutes: number;
        icon: string;
        id?: string;
        steps: Array<{
            bodyMd?: string;
            icon?: string;
            id?: string;
            title?: string;
            type: 'slide';
        } | {
            choices?: Array<{
                correct?: boolean;
                id?: string;
                label?: string;
            }>;
            explanation?: string;
            icon?: string;
            id?: string;
            multi?: boolean;
            question?: string;
            title?: string;
            type: 'quiz';
        } | {
            criteria?: Array<string>;
            guidance?: string;
            icon?: string;
            id?: string;
            instruction?: string;
            maxAttempts?: number;
            passScore?: number;
            placeholder?: string;
            task?: string;
            title?: string;
            type: 'exercise';
        }>;
        title: string;
    }>;
    'GET /ai/learning/catalog': Op;
    'POST /ai/learning/certificate': Op<NoParams, UndeclaredQuery, {
        certificateId?: string;
        makePublic?: boolean;
    }>;
    'GET /ai/learning/certificate/{certId}/certificate.pdf': Op<{ certId: string | number }>;
    'GET /ai/learning/certificate/{certId}/image.png': Op<{ certId: string | number }>;
    'POST /ai/learning/coach': Op<NoParams, UndeclaredQuery, {
        exerciseId?: string;
        locale?: string;
        mode?: 'grade' | 'hint';
        modelTier?: string;
        submission?: string;
    }>;
    'GET /ai/learning/org-overview': Op;
    'POST /ai/learning/practice/generate': Op<NoParams, UndeclaredQuery, {
        count?: number | string;
        lessonIds?: Array<string | number>;
        locale?: string;
        modelTier?: string;
    }>;
    'POST /ai/learning/practice/grade': Op<NoParams, UndeclaredQuery, {
        choiceIds?: Array<string | number>;
        itemId?: string;
        practiceId?: string;
    }>;
    'POST /ai/learning/quiz/grade': Op<NoParams, UndeclaredQuery, {
        choiceIds?: Array<string | number>;
        lessonId?: string;
        stepId?: string;
    }>;
    'GET /ai/learning/training-gates': Op;
    'GET /ai/learning/training-rules': Op;
    'PUT /ai/learning/training-rules': Op<NoParams, UndeclaredQuery, {
        areas: Record<string, unknown>;
    }>;
    'POST /ai/learning/tutor': Op<NoParams, UndeclaredQuery, {
        lessonId?: string;
        locale?: string;
        modelTier?: string;
        question?: string;
        stepContext?: string;
        stepId?: string;
    }>;
    'GET /ai/local-runtimes': Op;
    'POST /ai/local-runtimes/detect': Op<NoParams, UndeclaredQuery, Record<string, never>>;
    'GET /ai/local-runtimes/models': Op;
    'POST /ai/local-runtimes/test': Op<NoParams, UndeclaredQuery, {
        apiKey?: string;
        type: string;
        url: string;
    }>;
    'POST /ai/local-runtimes/{id}/pull': Op<{ id: string | number }, UndeclaredQuery, {
        model: string;
    }>;
    'GET /ai/mcp-registry/search': Op<NoParams, {
        cursor?: string;
        q?: string;
        verifiedOnly?: '0' | '1' | 'true' | 'false';
    }>;
    'GET /ai/mcp-servers': Op;
    'POST /ai/mcp-servers': Op<NoParams, UndeclaredQuery, {
        args?: Array<unknown> | null;
        category?: string | null;
        command?: string | null;
        description?: string | null;
        icon?: string | null;
        name?: string;
        required_credentials?: Array<unknown> | null;
        source?: string;
        transport?: 'stdio' | 'http';
        url?: string | null;
    }>;
    'POST /ai/mcp-servers/test': Op<NoParams, UndeclaredQuery, {
        args?: Array<unknown> | null;
        command?: string | null;
        transport?: 'stdio' | 'http';
        url?: string | null;
    }>;
    'GET /ai/mcp-servers/user-credentials': Op;
    'POST /ai/mcp-servers/user-credentials': Op<NoParams, UndeclaredQuery, {
        credKey: string;
        serverId: string;
        value?: string | null;
    }>;
    'PUT /ai/mcp-servers/{id}': Op<{ id: string | number }, UndeclaredQuery, {
        args?: Array<unknown> | null;
        category?: string | null;
        command?: string | null;
        description?: string | null;
        enabled?: boolean;
        icon?: string | null;
        name?: string;
        required_credentials?: Array<unknown> | null;
        transport?: 'stdio' | 'http';
        url?: string | null;
    }>;
    'DELETE /ai/mcp-servers/{id}': Op<{ id: string | number }>;
    'POST /ai/mcp-servers/{id}/refresh': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /ai/model-costs': Op;
    'POST /ai/model-costs': Op<NoParams, UndeclaredQuery, {
        costs: Array<{
            input?: number;
            model: string;
            output?: number;
            reset?: boolean;
        }>;
    }>;
    'GET /ai/model-costs-config': Op;
    'GET /ai/n8n/config': Op;
    'PUT /ai/n8n/config': Op<NoParams, UndeclaredQuery, {
        apiKey?: string | null;
        n8nUrl?: string | null;
    }>;
    'GET /ai/n8n/diagnostics': Op;
    'POST /ai/n8n/enable-for-org': Op<NoParams, UndeclaredQuery, Record<string, never>>;
    'GET /ai/n8n/permissions': Op;
    'PUT /ai/n8n/permissions': Op<NoParams, UndeclaredQuery, {
        action?: string;
        groupId?: string;
        permission?: string;
    }>;
    'POST /ai/n8n/test': Op<NoParams, UndeclaredQuery, {
        apiKey?: string | null;
        n8nUrl?: string | null;
    }>;
    'GET /ai/n8n/workflow/{workflowId}': Op<{ workflowId: string | number }>;
    'GET /ai/n8n/workflows': Op;
    'PUT /ai/n8n/workflows': Op<NoParams, UndeclaredQuery, {
        workflows?: Array<Record<string, unknown>> | null;
    }>;
    'GET /ai/providers': Op;
    'POST /ai/providers': Op<NoParams, UndeclaredQuery, {
        apiKey?: string;
        apiVersion?: string;
        location?: string;
        model?: string;
        name: string;
        project?: string;
        serviceAccountKey?: string;
        type: string;
        url?: string;
    }>;
    'PUT /ai/providers/{id}': Op<{ id: string | number }, UndeclaredQuery, {
        apiKey?: string;
        apiVersion?: string;
        location?: string;
        model?: string;
        name?: string;
        project?: string;
        serviceAccountKey?: string;
        type?: string;
        url?: string;
    }>;
    'DELETE /ai/providers/{id}': Op<{ id: string | number }>;
    'PUT /ai/providers/{id}/default': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /ai/providers/{id}/models': Op<{ id: string | number }, {
        refresh?: 'true' | 'false';
    }>;
    'PUT /ai/providers/{id}/region': Op<{ id: string | number }, UndeclaredQuery, {
        region: 'eu' | 'default';
    }>;
    'GET /ai/swarms/available': Op;
    'GET /ai/user-settings': Op;
    'POST /ai/user-settings': Op<NoParams, UndeclaredQuery, {
        afasEnvType?: string | null;
        afasMemberNumber?: string | null;
        afasToken?: string | null;
        enabledApps?: Array<string> | null;
        firebirdCharset?: string | null;
        firebirdDatabase?: string | null;
        firebirdHost?: string | null;
        firebirdPassword?: string | null;
        firebirdPort?: string | null;
        firebirdUser?: string | null;
        firefliesApiKey?: string | null;
        frappeCrmApiKey?: string | null;
        frappeCrmApiSecret?: string | null;
        frappeCrmUrl?: string | null;
        gammaApiKey?: string | null;
        hasSeenIntroTour?: boolean;
        learningPath?: 'everyday' | 'builder' | 'admin' | 'skipped' | '';
        learningProgress?: Record<string, unknown> | null;
        learningProgressReset?: boolean;
        memoryEnabled?: boolean;
        memorySensitiveOptIn?: boolean;
        nmbrsApiMode?: string | null;
        nmbrsClientId?: string | null;
        nmbrsClientSecret?: string | null;
        nmbrsEmail?: string | null;
        nmbrsEnv?: string | null;
        nmbrsSubdomain?: string | null;
        nmbrsSubscriptionKey?: string | null;
        nmbrsToken?: string | null;
        scalewayBillingOrgId?: string | null;
        scalewayBillingSecretKey?: string | null;
        signrequestSubdomain?: string | null;
        signrequestToken?: string | null;
        simpleMode?: boolean;
        userEuModeEnabled?: unknown;
        vplanApiEnv?: string | null;
        vplanApiKey?: string | null;
        youtrackToken?: string | null;
        youtrackUrl?: string | null;
    }>;
    'GET /ai/voice/availability': Op;
    'POST /ai/voice/session': Op<NoParams, UndeclaredQuery, {
        agentId?: string | null;
        language?: string | null;
        voice?: string | null;
    }>;
    'POST /ai/voice/turn': Op<NoParams, UndeclaredQuery, {
        agentId?: string;
        history?: string;
        language?: string;
        model?: string;
        systemPrompt?: string;
        voice?: string;
    }>;
    'GET /api': Op;
    'POST /api/admin/guard/install': Op<NoParams, UndeclaredQuery, {
        apiKey?: string;
        model?: string;
    }>;
    'GET /api/admin/guard/status': Op;
    'POST /api/admin/guard/uninstall': Op<NoParams, UndeclaredQuery, {
        removeVolume?: boolean;
    }>;
    'GET /api/admin/licenses': Op<NoParams, {
        includeInactive?: 'true' | 'false';
        organizationId?: string;
    }>;
    'GET /api/admin/licenses/capabilities': Op;
    'POST /api/admin/licenses/grant': Op<NoParams, UndeclaredQuery, {
        billingInterval?: 'monthly' | 'yearly';
        deliverEmail?: string;
        expiresAt: string;
        featuresOverride?: Array<string> | null;
        limitsOverride?: Record<string, number | null> | null;
        maxSeats?: number | null;
        notes?: string | null;
        organizationId?: string | null;
        scope?: 'organization' | 'server';
        tier: string;
    }>;
    'POST /api/admin/licenses/import': Op<NoParams, UndeclaredQuery, {
        blob: string;
        organizationId?: string | null;
    }>;
    'POST /api/admin/licenses/{id}/extend': Op<{ id: string | number }, UndeclaredQuery, {
        expiresAt: string;
    }>;
    'POST /api/admin/licenses/{id}/revoke': Op<{ id: string | number }, UndeclaredQuery, {
        reason?: string;
    }>;
    'GET /api/admin/metrics': Op;
    'GET /api/admin/modules': Op;
    'GET /api/admin/modules/audit': Op<NoParams, {
        limit?: number;
        moduleId?: string;
    }>;
    'POST /api/admin/modules/connect': Op<NoParams, UndeclaredQuery, {
        hubUrl?: string;
    }>;
    'POST /api/admin/modules/disconnect': Op<NoParams, UndeclaredQuery, Record<string, never>>;
    'POST /api/admin/modules/entitlements/refresh': Op<NoParams, UndeclaredQuery, Record<string, never>>;
    'GET /api/admin/modules/health': Op;
    'GET /api/admin/modules/marketplace': Op<NoParams, {
        category?: string;
        cursor?: string;
        limit?: number;
        q?: string;
    }>;
    'GET /api/admin/modules/marketplace/{id}': Op<{ id: string | number }>;
    'GET /api/admin/modules/marketplace/{id}/media/{mediaId}': Op<{ id: string | number; mediaId: string | number }>;
    'POST /api/admin/modules/sideload': Op<NoParams, {
        acceptedPermissions?: string;
    }>;
    'POST /api/admin/modules/{id}/activate-staged': Op<{ id: string | number }, UndeclaredQuery, {
        version?: string;
    }>;
    'GET /api/admin/modules/{id}/health': Op<{ id: string | number }>;
    'POST /api/admin/modules/{id}/import': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/admin/modules/{id}/install': Op<{ id: string | number }, UndeclaredQuery, {
        acceptedPermissions?: Array<string>;
        version?: string;
    }>;
    'GET /api/admin/modules/{id}/install-progress': Op<{ id: string | number }>;
    'GET /api/admin/modules/{id}/logs': Op<{ id: string | number }, {
        level?: 'debug' | 'info' | 'warn' | 'error' | 'system';
        limit?: number;
    }>;
    'POST /api/admin/modules/{id}/offline-grant': Op<{ id: string | number }>;
    'POST /api/admin/modules/{id}/purchase': Op<{ id: string | number }, UndeclaredQuery, {
        cancelUrl?: string;
        priceId?: string;
        price_id?: string;
        successUrl?: string;
    }>;
    'POST /api/admin/modules/{id}/reactivate': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/admin/modules/{id}/remove': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/admin/modules/{id}/rollback': Op<{ id: string | number }, UndeclaredQuery, {
        force?: boolean;
        version?: string;
    }>;
    'POST /api/admin/modules/{id}/update': Op<{ id: string | number }, UndeclaredQuery, {
        acceptedPermissions?: Array<string>;
    }>;
    'PATCH /api/admin/modules/{id}/update-policy': Op<{ id: string | number }, UndeclaredQuery, {
        channel?: 'stable' | 'beta';
        pin?: 'none' | 'major' | 'minor';
    }>;
    'GET /api/admin/modules/{id}/versions': Op<{ id: string | number }>;
    'GET /api/ai-participation/me': Op;
    'PUT /api/ai-participation/me': Op<NoParams, UndeclaredQuery, {
        autoJoinOnMyMessages: boolean;
    }>;
    'GET /api/ai-participation/org/{orgId}': Op<{ orgId: string | number }>;
    'PUT /api/ai-participation/org/{orgId}': Op<{ orgId: string | number }, UndeclaredQuery, {
        alwaysAllowed: boolean;
        autoAllowed: boolean;
        commentUnansweredMinutes?: number;
        commentsAutoAllowed: boolean;
        cooldownMinutes?: number;
        maxAutoPerChatHour?: number;
        maxAutoPerProjectDay?: number;
        maxDebounceSeconds?: number;
        maxGatesPerChatHour?: number;
        maxGatesPerOrgDay?: number;
        quietSeconds?: number;
        sensitivity?: 'conservative' | 'balanced' | 'eager';
        unansweredMinutes?: number;
    }>;
    'POST /api/app-hooks/{endpointId}': Op<{ endpointId: string | number }>;
    'GET /api/automation': Op<NoParams, {
        triggerEvent?: string;
        triggerProvider?: string;
    }>;
    'POST /api/automation': Op<NoParams, UndeclaredQuery, {
        createdFromChatId?: string | null;
        definition: Record<string, unknown>;
        description?: string | null;
        scheduleCron?: string | null;
        scheduleTz?: string;
        templateId?: string | null;
        title: string;
        triggerType?: string;
    }>;
    'GET /api/automation/_runs/active': Op;
    'GET /api/automation/_runs/facets': Op<NoParams, {
        automationId?: string;
        kind?: string;
        mode?: string;
        range?: number;
    }>;
    'GET /api/automation/_runs/org': Op<NoParams, {
        automationId?: string;
        cursor?: string;
        kind?: string;
        limit?: number;
        mode?: string;
        q?: string;
        since?: string;
        startedBy?: string;
        status?: string;
        tests?: 'include' | 'exclude' | 'only';
        trigger?: string;
        triggerKind?: string;
        until?: string;
    }>;
    'GET /api/automation/_runs/org/facets': Op<NoParams, {
        automationId?: string;
        kind?: string;
        mode?: string;
        range?: number;
    }>;
    'GET /api/automation/_runs/recent': Op<NoParams, {
        automationId?: string;
        cursor?: string;
        kind?: string;
        limit?: number;
        mode?: string;
        q?: string;
        since?: string;
        startedBy?: string;
        status?: string;
        tests?: 'include' | 'exclude' | 'only';
        trigger?: string;
        triggerKind?: string;
        until?: string;
    }>;
    'GET /api/automation/_runs/stream': Op<NoParams, {
        automationId?: string;
    }>;
    'POST /api/automation/_schedule/preview': Op<NoParams, UndeclaredQuery, {
        count?: number;
        cron: string;
        skipHolidays?: boolean;
        tz?: string;
    }>;
    'GET /api/automation/_trash': Op;
    'GET /api/automation/_usage/steps': Op;
    'GET /api/automation/_usage/values': Op<NoParams, {
        input: string;
        tool: string;
    }>;
    'GET /api/automation/approvals': Op<NoParams, {
        appId?: string;
        automationId?: string;
        cursor?: string;
        limit?: number;
        q?: string;
        scope?: 'mine' | 'org';
        status?: string;
    }>;
    'GET /api/automation/approvals/directory': Op;
    'GET /api/automation/approvals/facets': Op<NoParams, {
        appId?: string;
        scope?: 'mine' | 'org';
    }>;
    'GET /api/automation/approvals/{id}': Op<{ id: string | number }>;
    'POST /api/automation/approvals/{id}/decide': Op<{ id: string | number }, UndeclaredQuery, {
        answers?: Record<string, unknown> | null;
        decision: 'approve' | 'reject';
        reason?: string | null;
    }>;
    'GET /api/automation/approvals/{id}/files/{fileId}': Op<{ id: string | number; fileId: string | number }>;
    'POST /api/automation/approvals/{id}/remind': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/automation/approvals/{id}/withdraw': Op<{ id: string | number }, UndeclaredQuery, {
        reason?: string | null;
    }>;
    'POST /api/automation/builder/code/assist': Op<NoParams, UndeclaredQuery, {
        allowedHosts?: Array<string> | null;
        allowedTools?: Array<string> | null;
        automationId?: string | null;
        code?: string | null;
        messages: Array<{
            content: string;
            role: 'user' | 'assistant';
        }>;
        modelTier?: string | null;
        stepId?: string | null;
        upstreamFields?: Array<{
            label?: string | null;
            path: string;
            type?: string | null;
            [key: string]: unknown;
        }> | null;
    }>;
    'POST /api/automation/builder/feedback': Op<NoParams, UndeclaredQuery, {
        action: string;
        reason?: string | null;
        reasonCode?: string | null;
        signature?: string | null;
        suggestion: {
            buildPrompt?: string | null;
            complexity?: string | null;
            groundedIn?: string | null;
            id?: string | null;
            requiredIntegrations?: Array<string> | null;
            title: string;
            [key: string]: unknown;
        };
    }>;
    'POST /api/automation/builder/label-steps': Op<NoParams, UndeclaredQuery, {
        allowedIcons?: Array<string>;
        definition: unknown;
    }>;
    'POST /api/automation/builder/layer-agent': Op<NoParams, UndeclaredQuery, {
        automationId: string;
        instruction: string;
        layerKey?: string | null;
        mode?: 'create' | 'refine';
        title?: string | null;
    }>;
    'POST /api/automation/builder/map-json-fields': Op<NoParams, UndeclaredQuery, {
        existingFields?: Array<{
            description?: string;
            name: string;
            path?: string;
        }>;
        instruction: string;
        sample?: unknown;
    }>;
    'POST /api/automation/builder/route-rules': Op<NoParams, UndeclaredQuery, {
        description: string;
        fields?: Array<{
            key?: string | null;
            name?: string | null;
            type?: string | null;
        }>;
        itemVar?: string;
        perItem?: boolean;
    }>;
    'GET /api/automation/builder/session/{automationId}': Op<{ automationId: string | number }>;
    'POST /api/automation/builder/session/{automationId}/review': Op<{ automationId: string | number }, UndeclaredQuery, {
        action: 'applyProposal' | 'discardProposal' | 'rejectPlan';
        revisionId: string;
    }>;
    'POST /api/automation/builder/stream': Op<NoParams, {
        resume?: '1' | 'true';
    }, {
        alwaysPlanLarge?: boolean;
        approvedPlanId?: string | null;
        attachments?: Array<unknown> | null;
        automationId?: string | null;
        builderSessionId?: string | null;
        canvasScope?: string | null;
        disabledMedia?: Record<string, unknown> | null;
        history?: Array<unknown> | null;
        message?: string | null;
        modelTier?: string | null;
        pauseAfterStep?: boolean;
        seedMetadata?: {
            description?: string;
            title?: string;
        } | null;
        selectedStepId?: string | null;
        timezone?: string | null;
        webSearchEnabled?: boolean | null;
        workMode?: 'describe' | 'discuss' | 'approve' | 'plan' | 'build';
    }>;
    'POST /api/automation/builder/suggest': Op<NoParams, UndeclaredQuery, {
        focus?: string;
        force?: boolean;
        integrationIds?: Array<string>;
        mode?: 'patterns' | 'ideas';
        sources?: Array<string>;
        timezone?: string;
    }>;
    'POST /api/automation/builder/suggest-mappings': Op<NoParams, UndeclaredQuery, {
        mapped?: Array<{
            key: string;
            kind: 'literal' | 'ref' | 'template' | 'expr';
            paths?: Array<string>;
        }>;
        params: Array<{
            description?: string | null;
            enum?: Array<string | number | boolean | null> | null;
            format?: string | null;
            itemsType?: string | null;
            key: string;
            required?: boolean;
            title?: string | null;
            type?: string | Array<string> | null;
        }>;
        sources: Array<{
            label?: string;
            real?: boolean;
            root: string;
            sample?: unknown;
        }>;
        step?: {
            label?: string;
            tool?: string;
        };
    }>;
    'GET /api/automation/builder/suggest/last': Op<NoParams, {
        mode?: 'patterns' | 'ideas';
    }>;
    'GET /api/automation/builder/suggest/sources': Op;
    'POST /api/automation/builder/summarise-layer': Op<NoParams, UndeclaredQuery, {
        layer: unknown;
    }>;
    'POST /api/automation/builder/topic-preview': Op<NoParams, UndeclaredQuery, {
        labels: Array<string>;
        texts: Array<string>;
    }>;
    'GET /api/automation/by-agent/{agentId}/automation-ids': Op<{ agentId: string | number }>;
    'GET /api/automation/catalog': Op;
    'GET /api/automation/catalog/agent/{agentId}': Op<{ agentId: string | number }, {
        disabledAgentSkillIds?: string;
        skillIds?: string;
        startAutomations?: '0' | '1' | 'true' | 'false';
        tools?: string;
        useKnowledge?: '0' | '1' | 'true' | 'false';
        useTools?: '0' | '1' | 'true' | 'false';
    }>;
    'GET /api/automation/catalog/form-pick-sources': Op;
    'GET /api/automation/catalog/nextcloud-tables/{tableId}/columns': Op<{ tableId: string | number }>;
    'GET /api/automation/catalog/sample/{tool}': Op<{ tool: string | number }>;
    'GET /api/automation/catalog/skill/{skillId}': Op<{ skillId: string | number }>;
    'POST /api/automation/code/analyze': Op<NoParams, UndeclaredQuery, {
        allowedHosts?: Array<string>;
        allowedTools?: Array<string>;
        automationId?: string;
        code: string;
        stepId?: string;
    }>;
    'POST /api/automation/code/test': Op<NoParams, UndeclaredQuery, {
        allowedHosts?: Array<string>;
        allowedTools?: Array<string>;
        automationId?: string;
        code: string;
        inputs?: Record<string, unknown>;
        limits?: {
            cpuMs?: number;
            httpBudget?: number;
            memoryMb?: number;
            wallMs?: number;
        };
        stepId?: string;
    }>;
    'POST /api/automation/events/github': Op;
    'POST /api/automation/events/gmail': Op;
    'POST /api/automation/events/msgraph': Op;
    'POST /api/automation/events/nextcloud': Op;
    'GET /api/automation/folders': Op;
    'POST /api/automation/folders': Op<NoParams, UndeclaredQuery, {
        color?: string | null;
        icon?: string;
        name: string;
        parentId?: string | null;
    }>;
    'PUT /api/automation/folders/{folderId}': Op<{ folderId: string | number }, UndeclaredQuery, {
        color?: string | null;
        icon?: string;
        name?: string;
        parentId?: string | null;
    }>;
    'DELETE /api/automation/folders/{folderId}': Op<{ folderId: string | number }>;
    'GET /api/automation/form/{token}': Op<{ token: string | number }>;
    'POST /api/automation/form/{token}': Op<{ token: string | number }>;
    'POST /api/automation/form/{token}/pick': Op<{ token: string | number }, UndeclaredQuery, {
        csrf?: unknown;
        field?: unknown;
        limit?: unknown;
        query?: unknown;
        sessionId?: unknown;
    }>;
    'GET /api/automation/form/{token}/s/{sid}': Op<{ token: string | number; sid: string | number }>;
    'POST /api/automation/form/{token}/s/{sid}': Op<{ token: string | number; sid: string | number }>;
    'GET /api/automation/form/{token}/s/{sid}/export/{format}': Op<{ token: string | number; sid: string | number; format: string | number }>;
    'GET /api/automation/form/{token}/s/{sid}/file/{fileId}': Op<{ token: string | number; sid: string | number; fileId: string | number }>;
    'POST /api/automation/form/{token}/s/{sid}/file/{fileId}/notebook': Op<{ token: string | number; sid: string | number; fileId: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/automation/form/{token}/s/{sid}/notebook': Op<{ token: string | number; sid: string | number }, UndeclaredQuery, {
        text?: unknown;
        title?: unknown;
    }>;
    'POST /api/automation/form/{token}/s/{sid}/webpage': Op<{ token: string | number; sid: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/automation/form/{token}/upload': Op<{ token: string | number }>;
    'GET /api/automation/forms': Op;
    'POST /api/automation/forms/ai/draft': Op<NoParams, UndeclaredQuery, {
        brief?: string;
        current?: Record<string, unknown> | null;
        mode?: 'create' | 'revise';
        note?: string;
    }>;
    'GET /api/automation/forms/{automationId}': Op<{ automationId: string | number }>;
    'POST /api/automation/forms/{automationId}/answers-table': Op<{ automationId: string | number }, UndeclaredQuery, Record<string, never>>;
    'PUT /api/automation/forms/{automationId}/audience': Op<{ automationId: string | number }, UndeclaredQuery, {
        audience: 'org' | 'restricted';
        sharedGroups?: Array<string>;
        sharedUserIds?: Array<string>;
    }>;
    'GET /api/automation/forms/{automationId}/test-link': Op<{ automationId: string | number }>;
    'POST /api/automation/forms/{automationId}/test-link': Op<{ automationId: string | number }, UndeclaredQuery, Record<string, never>>;
    'DELETE /api/automation/forms/{automationId}/test-link': Op<{ automationId: string | number }>;
    'PUT /api/automation/forms/{automationId}/test-link/audience': Op<{ automationId: string | number }, UndeclaredQuery, {
        audience: 'org' | 'restricted';
        sharedGroups?: Array<string>;
        sharedUserIds?: Array<string>;
    }>;
    'POST /api/automation/import': Op;
    'GET /api/automation/runs/{id}': Op<{ id: string | number }>;
    'POST /api/automation/runs/{id}/approve': Op<{ id: string | number }, UndeclaredQuery, {
        decision: 'approve' | 'reject';
        reason?: string;
    }>;
    'GET /api/automation/runs/{id}/steps': Op<{ id: string | number }>;
    'GET /api/automation/runs/{id}/steps/{stepId}/full-output': Op<{ id: string | number; stepId: string | number }, {
        attempts?: number;
    }>;
    'POST /api/automation/runs/{runId}/approve-step': Op<{ runId: string | number }, UndeclaredQuery, {
        answers?: unknown;
        decision: 'approve' | 'reject';
        reason?: string;
        respond?: 'created' | 'finished';
    }>;
    'POST /api/automation/runs/{runId}/cancel': Op<{ runId: string | number }, UndeclaredQuery, {
        reason?: string;
    }>;
    'GET /api/automation/runs/{runId}/compare/{otherRunId}': Op<{ runId: string | number; otherRunId: string | number }, {
        stepId?: string;
    }>;
    'GET /api/automation/runs/{runId}/files': Op<{ runId: string | number }>;
    'GET /api/automation/runs/{runId}/files/{fileId}': Op<{ runId: string | number; fileId: string | number }>;
    'GET /api/automation/runs/{runId}/files/{fileId}/preview': Op<{ runId: string | number; fileId: string | number }>;
    'GET /api/automation/runs/{runId}/form': Op<{ runId: string | number }>;
    'POST /api/automation/runs/{runId}/form': Op<{ runId: string | number }, UndeclaredQuery, {
        respond?: 'created' | 'finished';
        stepId?: string;
        values?: Record<string, unknown>;
    }>;
    'POST /api/automation/runs/{runId}/golden': Op<{ runId: string | number }, UndeclaredQuery, {
        ignorePaths?: Array<string>;
        label?: string;
    }>;
    'DELETE /api/automation/runs/{runId}/golden': Op<{ runId: string | number }>;
    'GET /api/automation/runs/{runId}/tables/{tableId}': Op<{ runId: string | number; tableId: string | number }>;
    'GET /api/automation/runs/{runId}/tables/{tableId}/csv': Op<{ runId: string | number; tableId: string | number }>;
    'GET /api/automation/templates': Op;
    'GET /api/automation/templates/{id}': Op<{ id: string | number }>;
    'POST /api/automation/webhook/{slug}': Op<{ slug: string | number }>;
    'GET /api/automation/{id}': Op<{ id: string | number }>;
    'PUT /api/automation/{id}': Op<{ id: string | number }, UndeclaredQuery, {
        definition?: Record<string, unknown>;
        description?: string | null;
        folderId?: string | null;
        icon?: string | null;
        isDraft?: boolean;
        scheduleCron?: string | null;
        scheduleTz?: string | null;
        title?: string;
        triggerType?: string;
    }>;
    'DELETE /api/automation/{id}': Op<{ id: string | number }>;
    'POST /api/automation/{id}/activate': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/automation/{id}/agent-bindings': Op<{ id: string | number }>;
    'PUT /api/automation/{id}/agent-bindings': Op<{ id: string | number }, UndeclaredQuery, {
        agentIds: Array<string>;
    }>;
    'POST /api/automation/{id}/agent-invoke': Op<{ id: string | number }, UndeclaredQuery, {
        args?: Record<string, unknown>;
    }>;
    'GET /api/automation/{id}/ai-act': Op<{ id: string | number }>;
    'PUT /api/automation/{id}/ai-act': Op<{ id: string | number }, UndeclaredQuery, {
        domains?: unknown;
        externalOutput?: unknown;
        sensitiveUse?: unknown;
        usesAi?: unknown;
    }>;
    'PUT /api/automation/{id}/ai-act/answers': Op<{ id: string | number }, UndeclaredQuery, {
        domains?: unknown;
        externalOutput?: unknown;
        practices?: unknown;
        prohibitedUse?: unknown;
        sensitiveUse?: unknown;
        usesAi?: unknown;
    }>;
    'GET /api/automation/{id}/ai-act/check': Op<{ id: string | number }>;
    'GET /api/automation/{id}/ai-act/suggestion': Op<{ id: string | number }>;
    'GET /api/automation/{id}/caller-notice': Op<{ id: string | number }>;
    'POST /api/automation/{id}/caller-notice/seen': Op<{ id: string | number }, UndeclaredQuery, {
        items: Array<string>;
    }>;
    'GET /api/automation/{id}/counts': Op<{ id: string | number }>;
    'POST /api/automation/{id}/deactivate': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/automation/{id}/diagnose-trigger': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/automation/{id}/dry-run': Op<{ id: string | number }, UndeclaredQuery, {
        answersFromRunId?: string;
        pauses?: 'real';
        respond?: 'created' | 'finished';
        triggerPayload?: unknown;
        triggerStepId?: string | null;
    }>;
    'POST /api/automation/{id}/duplicate': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/automation/{id}/export': Op<{ id: string | number }>;
    'POST /api/automation/{id}/form': Op<{ id: string | number }, UndeclaredQuery, {
        triggerStepId?: string | null;
    }>;
    'POST /api/automation/{id}/form-pick': Op<{ id: string | number }, UndeclaredQuery, {
        limit?: unknown;
        query?: unknown;
        source: string;
    }>;
    'GET /api/automation/{id}/form-scenarios': Op<{ id: string | number }>;
    'POST /api/automation/{id}/form-scenarios': Op<{ id: string | number }, UndeclaredQuery, {
        fromRunId: string;
        name: string;
    }>;
    'GET /api/automation/{id}/form-scenarios/{scenarioId}': Op<{ id: string | number; scenarioId: string | number }>;
    'PUT /api/automation/{id}/form-scenarios/{scenarioId}': Op<{ id: string | number; scenarioId: string | number }, UndeclaredQuery, {
        name: string;
    }>;
    'DELETE /api/automation/{id}/form-scenarios/{scenarioId}': Op<{ id: string | number; scenarioId: string | number }>;
    'POST /api/automation/{id}/form-scenarios/{scenarioId}/dry-run': Op<{ id: string | number; scenarioId: string | number }, UndeclaredQuery, {
        triggerStepId?: string | null;
    }>;
    'POST /api/automation/{id}/form-test': Op<{ id: string | number }, UndeclaredQuery, {
        mode?: 'dry' | 'live';
        respond?: 'created' | 'finished';
        triggerStepId?: string | null;
        untilStepId?: string | null;
        values?: Record<string, unknown>;
    }>;
    'POST /api/automation/{id}/form-test/upload': Op<{ id: string | number }>;
    'DELETE /api/automation/{id}/form/{token}': Op<{ id: string | number; token: string | number }>;
    'POST /api/automation/{id}/form/{token}/rotate': Op<{ id: string | number; token: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/automation/{id}/forms': Op<{ id: string | number }>;
    'POST /api/automation/{id}/forms/style-assist': Op<{ id: string | number }, UndeclaredQuery, {
        customCss?: string | null;
        prompt: string;
        style?: Record<string, unknown> | null;
        theme?: Record<string, unknown> | null;
        triggerStepId?: string | null;
    }>;
    'GET /api/automation/{id}/goldens': Op<{ id: string | number }>;
    'POST /api/automation/{id}/goldens/replay': Op<{ id: string | number }, UndeclaredQuery, {
        aiAnswers?: 'live' | 'cache';
        goldenIds?: Array<string>;
    }>;
    'GET /api/automation/{id}/notifications': Op<{ id: string | number }>;
    'GET /api/automation/{id}/principals': Op<{ id: string | number }>;
    'POST /api/automation/{id}/publish': Op<{ id: string | number }, UndeclaredQuery, {
        version?: number;
    }>;
    'GET /api/automation/{id}/readiness': Op<{ id: string | number }>;
    'POST /api/automation/{id}/restore': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/automation/{id}/run': Op<{ id: string | number }, UndeclaredQuery, {
        respond?: 'created' | 'finished';
        test?: boolean;
        triggerPayload?: unknown;
        triggerStepId?: string | null;
    }>;
    'GET /api/automation/{id}/runs': Op<{ id: string | number }, {
        automationId?: string;
        cursor?: string;
        kind?: string;
        limit?: number;
        mode?: string;
        q?: string;
        since?: string;
        startedBy?: string;
        status?: string;
        tests?: 'include' | 'exclude' | 'only';
        trigger?: string;
        triggerKind?: string;
        until?: string;
    }>;
    'POST /api/automation/{id}/runs/{runId}/retry': Op<{ id: string | number; runId: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/automation/{id}/save-as-template': Op<{ id: string | number }, UndeclaredQuery, {
        description?: string | null;
        title?: string;
    }>;
    'GET /api/automation/{id}/shares': Op<{ id: string | number }>;
    'PUT /api/automation/{id}/shares': Op<{ id: string | number }, UndeclaredQuery, {
        shares: Array<{
            principalId: string;
            principalType: 'user' | 'group';
            role: 'run' | 'view' | 'edit';
        }>;
    }>;
    'GET /api/automation/{id}/steps/{stepId}/rerun-plan': Op<{ id: string | number; stepId: string | number }, {
        mode?: 'only' | 'from';
        seedRunId: string;
        triggerStepId?: string;
    }>;
    'POST /api/automation/{id}/steps/{stepId}/run': Op<{ id: string | number; stepId: string | number }, UndeclaredQuery, {
        allowLiveUpstream?: boolean;
        confirmSideEffects?: boolean;
        mode?: 'only' | 'from' | 'upTo';
        respond?: 'created' | 'finished';
        seedRunId?: string | null;
        triggerPayload?: unknown;
        triggerStepId?: string | null;
    }>;
    'POST /api/automation/{id}/suggest-description': Op<{ id: string | number }, UndeclaredQuery, {
        language?: string;
    }>;
    'POST /api/automation/{id}/table-preview': Op<{ id: string | number }, UndeclaredQuery, {
        joinSources?: Record<string, {
            runId: string;
            tableId: string;
        } | {
            columns?: Array<{
                key: string;
                label: string;
                type: 'text' | 'number' | 'boolean' | 'date' | 'datetime' | 'mixed' | 'empty';
            }>;
            rows: Array<Record<string, unknown> | Array<unknown>>;
        } | {
            httpCalls?: Array<unknown>;
            logs?: Array<unknown>;
            result: Array<Record<string, unknown>> | {
                columns?: Array<{
                    key: string;
                    label: string;
                    type: 'text' | 'number' | 'boolean' | 'date' | 'datetime' | 'mixed' | 'empty';
                }>;
                rows: Array<Record<string, unknown> | Array<unknown>>;
            };
        }>;
        limit?: number;
        ops: Array<unknown>;
        source: {
            runId: string;
            tableId: string;
        } | {
            columns?: Array<{
                key: string;
                label: string;
                type: 'text' | 'number' | 'boolean' | 'date' | 'datetime' | 'mixed' | 'empty';
            }>;
            rows: Array<Record<string, unknown> | Array<unknown>>;
        } | {
            httpCalls?: Array<unknown>;
            logs?: Array<unknown>;
            result: Array<Record<string, unknown>> | {
                columns?: Array<{
                    key: string;
                    label: string;
                    type: 'text' | 'number' | 'boolean' | 'date' | 'datetime' | 'mixed' | 'empty';
                }>;
                rows: Array<Record<string, unknown> | Array<unknown>>;
            };
        };
        upToOpId?: string;
    }>;
    'GET /api/automation/{id}/test-cases': Op<{ id: string | number }, {
        stepId?: string;
    }>;
    'POST /api/automation/{id}/test-cases': Op<{ id: string | number }, UndeclaredQuery, {
        assertions?: Array<{
            id: string;
            op: 'equals' | 'not_equals' | 'contains' | 'has_key' | 'type_is' | 'count_is';
            path?: string;
            value?: unknown;
        }>;
        expect?: 'success' | 'error';
        input: {
            kind: 'typed';
            values: Record<string, unknown>;
        } | {
            attempts?: number;
            kind: 'run';
            runId: string;
        };
        name: string;
        stepId: string;
    }>;
    'POST /api/automation/{id}/test-cases/run': Op<{ id: string | number }, UndeclaredQuery, {
        caseIds?: Array<string>;
        code?: string;
        stepId: string;
    }>;
    'GET /api/automation/{id}/test-cases/{caseId}': Op<{ id: string | number; caseId: string | number }>;
    'PUT /api/automation/{id}/test-cases/{caseId}': Op<{ id: string | number; caseId: string | number }, UndeclaredQuery, {
        assertions?: Array<{
            id: string;
            op: 'equals' | 'not_equals' | 'contains' | 'has_key' | 'type_is' | 'count_is';
            path?: string;
            value?: unknown;
        }>;
        expect?: 'success' | 'error';
        input?: {
            kind: 'typed';
            values: Record<string, unknown>;
        } | {
            attempts?: number;
            kind: 'run';
            runId: string;
        };
        name?: string;
    }>;
    'DELETE /api/automation/{id}/test-cases/{caseId}': Op<{ id: string | number; caseId: string | number }>;
    'POST /api/automation/{id}/transfer-owner': Op<{ id: string | number }, UndeclaredQuery, {
        userId: string;
    }>;
    'GET /api/automation/{id}/usage': Op<{ id: string | number }>;
    'GET /api/automation/{id}/versions': Op<{ id: string | number }>;
    'GET /api/automation/{id}/versions/{versionId}': Op<{ id: string | number; versionId: string | number }>;
    'GET /api/automation/{id}/versions/{versionId}/diff/{otherVersionId}': Op<{ id: string | number; versionId: string | number; otherVersionId: string | number }>;
    'GET /api/automation/{id}/versions/{versionId}/fielddiff/{other}': Op<{ id: string | number; versionId: string | number; other: string | number }>;
    'PUT /api/automation/{id}/versions/{versionId}/name': Op<{ id: string | number; versionId: string | number }, UndeclaredQuery, {
        name: string | null;
    }>;
    'POST /api/automation/{id}/versions/{versionId}/restore': Op<{ id: string | number; versionId: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/automation/{id}/webhook': Op<{ id: string | number }, UndeclaredQuery, {
        triggerStepId?: string | null;
    }>;
    'DELETE /api/automation/{id}/webhook/{slug}': Op<{ id: string | number; slug: string | number }>;
    'POST /api/automation/{id}/webhook/{slug}/rotate': Op<{ id: string | number; slug: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/automation/{id}/webhook/{slug}/test': Op<{ id: string | number; slug: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/automation/{id}/webhooks': Op<{ id: string | number }>;
    'GET /api/billing/offered-plans': Op;
    'GET /api/billing/public-plans': Op;
    'GET /api/branding/admin': Op;
    'PUT /api/branding/admin': Op<NoParams, UndeclaredQuery, {
        accent?: string;
        allowUserOverride?: boolean;
        font?: 'system' | 'inter' | 'plex' | 'geist';
        glassAnimation?: 'off' | 'subtle' | 'lively';
        glassBorder?: 'none' | 'subtle' | 'bright' | 'iridescent';
        glassGrain?: 'off' | 'subtle' | 'frosted';
        glassIntensity?: number;
        glassLens?: 'off' | 'on';
        glassTierDefault?: {
            blur?: number;
            brightness?: number;
            saturate?: number;
        } | null;
        glassTierOpaque?: {
            blur?: number;
            brightness?: number;
            saturate?: number;
        } | null;
        glassTierSubtle?: {
            blur?: number;
            brightness?: number;
            saturate?: number;
        } | null;
        glassTint?: 'warm' | 'neutral' | 'cool';
        preset?: 'light' | 'dark' | 'glass' | 'glass-dark' | 'paper' | 'obsidian' | 'sepia' | 'high-contrast' | 'custom';
        radiusScale?: number;
        wallpaperOverlay?: number;
        wallpaperPreset?: 'mono' | 'slate' | 'sand' | 'frost' | 'sage' | 'ash';
    }>;
    'GET /api/branding/debug': Op;
    'GET /api/branding/effective': Op;
    'GET /api/branding/public': Op;
    'PUT /api/branding/user': Op<NoParams, UndeclaredQuery, {
        accent?: string;
        preset?: 'light' | 'dark' | 'glass' | 'glass-dark' | 'paper' | 'obsidian' | 'sepia' | 'high-contrast' | 'custom';
        wallpaperPreset?: 'mono' | 'slate' | 'sand' | 'frost' | 'sage' | 'ash';
    } | null>;
    'DELETE /api/branding/user': Op;
    'POST /api/branding/wallpaper': Op;
    'DELETE /api/branding/wallpaper': Op;
    'GET /api/branding/wallpaper/{filename}': Op<{ filename: string | number }>;
    'POST /api/chat/dlp-decision': Op<NoParams, UndeclaredQuery, {
        choice: 'redact' | 'block' | 'allow';
        decisionId: string;
        manualAdditions?: Array<{
            length: number;
            offset: number;
        }>;
        rememberForConversation?: boolean;
    }>;
    'POST /api/chat/dlp-decision/touch': Op<NoParams, UndeclaredQuery, {
        decisionId: string;
    }>;
    'POST /api/client-errors': Op;
    'GET /api/cms/admin/analytics/diagnose': Op;
    'GET /api/cms/admin/analytics/overview': Op;
    'GET /api/cms/admin/analytics/query/{resource}': Op<{ resource: string | number }>;
    'PUT /api/cms/admin/analytics/recorder': Op<NoParams, UndeclaredQuery, {
        enabled: boolean;
        siteId: string;
    }>;
    'POST /api/cms/admin/analytics/report/{type}': Op<{ type: string | number }>;
    'GET /api/cms/admin/analytics/settings': Op;
    'PUT /api/cms/admin/analytics/settings': Op<NoParams, UndeclaredQuery, {
        apiToken?: string | null;
        consentMode?: 'cookieless' | 'cookies';
        enabled?: boolean;
        password?: string | null;
        recorder?: {
            maskLevel?: string;
            sampleRate?: number;
        };
        tracker?: {
            doNotTrack?: boolean;
            domains?: string;
            excludeHash?: boolean;
            excludeSearch?: boolean;
            tag?: string;
        };
        url?: string | null;
        username?: string | null;
    }>;
    'GET /api/cms/admin/analytics/sites': Op;
    'GET /api/cms/admin/analytics/status': Op;
    'GET /api/cms/admin/assets': Op;
    'PUT /api/cms/admin/default-locale': Op<NoParams, UndeclaredQuery, {
        locale: string;
    }>;
    'PUT /api/cms/admin/enabled': Op<NoParams, UndeclaredQuery, {
        enabled: boolean;
        siteId?: string | null;
    }>;
    'GET /api/cms/admin/form-automations': Op;
    'PUT /api/cms/admin/form-automations/{automationId}': Op<{ automationId: string | number }, UndeclaredQuery, {
        enabled: boolean;
    }>;
    'PUT /api/cms/admin/form-automations/{automationId}/blocks/{blockId}': Op<{ automationId: string | number; blockId: string | number }, UndeclaredQuery, {
        approved: boolean;
    }>;
    'GET /api/cms/admin/graph': Op;
    'POST /api/cms/admin/pages': Op<NoParams, UndeclaredQuery, {
        copyFromId?: string | null;
        slug?: string | null;
        templateId?: string | null;
        title?: string | null;
    }>;
    'PUT /api/cms/admin/pages/order': Op<NoParams, UndeclaredQuery, {
        orderedIds: Array<string>;
    }>;
    'GET /api/cms/admin/pages/{id}': Op<{ id: string | number }>;
    'PUT /api/cms/admin/pages/{id}': Op<{ id: string | number }, UndeclaredQuery, {
        page: Record<string, unknown>;
    }>;
    'DELETE /api/cms/admin/pages/{id}': Op<{ id: string | number }>;
    'POST /api/cms/admin/pages/{id}/ai-translate/{locale}': Op<{ id: string | number; locale: string | number }, UndeclaredQuery, {
        modelTier?: string | null;
    }>;
    'PUT /api/cms/admin/pages/{id}/homepage': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'PUT /api/cms/admin/pages/{id}/locale/{locale}': Op<{ id: string | number; locale: string | number }, UndeclaredQuery, {
        override: Record<string, unknown>;
    }>;
    'DELETE /api/cms/admin/pages/{id}/locale/{locale}': Op<{ id: string | number; locale: string | number }>;
    'PUT /api/cms/admin/pages/{id}/meta': Op<{ id: string | number }, UndeclaredQuery, {
        hideFooter?: boolean;
        hideHeader?: boolean;
        isNotFound?: boolean;
        noAnalytics?: boolean;
        slug?: string;
        title?: string;
    }>;
    'POST /api/cms/admin/publish': Op<NoParams, UndeclaredQuery, Record<string, never>>;
    'GET /api/cms/admin/site': Op;
    'PUT /api/cms/admin/site': Op<NoParams, UndeclaredQuery, {
        site: Record<string, unknown>;
    }>;
    'POST /api/cms/admin/site/ai-translate/{locale}': Op<{ locale: string | number }, UndeclaredQuery, {
        modelTier?: string | null;
    }>;
    'PUT /api/cms/admin/site/locale/{locale}': Op<{ locale: string | number }, UndeclaredQuery, {
        override: Record<string, unknown>;
    }>;
    'DELETE /api/cms/admin/site/locale/{locale}': Op<{ locale: string | number }>;
    'GET /api/cms/admin/templates': Op;
    'POST /api/cms/admin/templates': Op<NoParams, UndeclaredQuery, {
        blocks: Array<unknown>;
        description?: string | null;
        name: string;
    }>;
    'DELETE /api/cms/admin/templates/{id}': Op<{ id: string | number }>;
    'POST /api/cms/admin/upload': Op;
    'POST /api/cms/admin/upload-clip': Op;
    'GET /api/cms/blog/posts': Op;
    'GET /api/cms/builder/session/{siteId}': Op<{ siteId: string | number }>;
    'POST /api/cms/builder/stream': Op<NoParams, UndeclaredQuery, {
        builderSessionId?: string | null;
        context?: Record<string, unknown> | null;
        message: string;
        modelTier?: string;
        siteId: string;
        timezone?: string;
    }>;
    'GET /api/cms/forms/{blockId}': Op<{ blockId: string | number }>;
    'POST /api/cms/forms/{blockId}': Op<{ blockId: string | number }, UndeclaredQuery, {
        answers: Record<string, unknown>;
        consent?: boolean;
        issuedAt: number;
        locale?: string;
        nonce?: string;
        ref_code_2?: string;
        token: string;
    }>;
    'GET /api/cms/site': Op;
    'GET /api/cms/sites': Op;
    'POST /api/cms/sites': Op<NoParams, UndeclaredQuery, {
        name?: string | null;
    }>;
    'POST /api/cms/sites/import': Op;
    'GET /api/cms/sites/{siteId}': Op<{ siteId: string | number }>;
    'PUT /api/cms/sites/{siteId}': Op<{ siteId: string | number }, UndeclaredQuery, {
        site: Record<string, unknown>;
    }>;
    'PATCH /api/cms/sites/{siteId}': Op<{ siteId: string | number }, UndeclaredQuery, {
        name: string;
    }>;
    'DELETE /api/cms/sites/{siteId}': Op<{ siteId: string | number }>;
    'POST /api/cms/sites/{siteId}/duplicate': Op<{ siteId: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/cms/sites/{siteId}/export': Op<{ siteId: string | number }>;
    'GET /api/cms/sites/{siteId}/graph': Op<{ siteId: string | number }>;
    'POST /api/cms/sites/{siteId}/link-check': Op<{ siteId: string | number }, UndeclaredQuery, {
        external?: boolean;
    }>;
    'PUT /api/cms/sites/{siteId}/live': Op<{ siteId: string | number }, UndeclaredQuery, {
        live: boolean;
    }>;
    'POST /api/cms/sites/{siteId}/pages': Op<{ siteId: string | number }, UndeclaredQuery, {
        copyFromId?: string | null;
        slug?: string | null;
        templateId?: string | null;
        title?: string | null;
    }>;
    'PUT /api/cms/sites/{siteId}/pages/order': Op<{ siteId: string | number }, UndeclaredQuery, {
        orderedIds: Array<string>;
    }>;
    'GET /api/cms/sites/{siteId}/pages/{id}': Op<{ siteId: string | number; id: string | number }>;
    'PUT /api/cms/sites/{siteId}/pages/{id}': Op<{ siteId: string | number; id: string | number }, UndeclaredQuery, {
        page: Record<string, unknown>;
    }>;
    'DELETE /api/cms/sites/{siteId}/pages/{id}': Op<{ siteId: string | number; id: string | number }>;
    'POST /api/cms/sites/{siteId}/pages/{id}/ai-translate/{locale}': Op<{ siteId: string | number; id: string | number; locale: string | number }, UndeclaredQuery, {
        modelTier?: string | null;
    }>;
    'PUT /api/cms/sites/{siteId}/pages/{id}/homepage': Op<{ siteId: string | number; id: string | number }, UndeclaredQuery, Record<string, never>>;
    'PUT /api/cms/sites/{siteId}/pages/{id}/locale/{locale}': Op<{ siteId: string | number; id: string | number; locale: string | number }, UndeclaredQuery, {
        override: Record<string, unknown>;
    }>;
    'DELETE /api/cms/sites/{siteId}/pages/{id}/locale/{locale}': Op<{ siteId: string | number; id: string | number; locale: string | number }>;
    'PUT /api/cms/sites/{siteId}/pages/{id}/meta': Op<{ siteId: string | number; id: string | number }, UndeclaredQuery, {
        hideFooter?: boolean;
        hideHeader?: boolean;
        isNotFound?: boolean;
        noAnalytics?: boolean;
        slug?: string;
        title?: string;
    }>;
    'GET /api/cms/sites/{siteId}/posts': Op<{ siteId: string | number }>;
    'POST /api/cms/sites/{siteId}/posts': Op<{ siteId: string | number }, UndeclaredQuery, {
        authorName?: string;
        body?: string;
        coverAlt?: string;
        coverImage?: string;
        excerpt?: string;
        publishedAt?: string | null;
        seo?: {
            metaDescription?: string;
            metaTitle?: string;
            noIndex?: boolean;
            ogImage?: string;
        };
        slug?: string;
        status?: 'draft' | 'scheduled' | 'published';
        tags?: Array<string>;
        title: string;
    }>;
    'GET /api/cms/sites/{siteId}/posts/{postId}': Op<{ siteId: string | number; postId: string | number }>;
    'PUT /api/cms/sites/{siteId}/posts/{postId}': Op<{ siteId: string | number; postId: string | number }, UndeclaredQuery, {
        authorName?: string;
        body?: string;
        coverAlt?: string;
        coverImage?: string;
        excerpt?: string;
        publishedAt?: string | null;
        seo?: {
            metaDescription?: string;
            metaTitle?: string;
            noIndex?: boolean;
            ogImage?: string;
        };
        slug?: string;
        status?: 'draft' | 'scheduled' | 'published';
        tags?: Array<string>;
        title?: string;
    }>;
    'DELETE /api/cms/sites/{siteId}/posts/{postId}': Op<{ siteId: string | number; postId: string | number }>;
    'PUT /api/cms/sites/{siteId}/posts/{postId}/locale/{locale}': Op<{ siteId: string | number; postId: string | number; locale: string | number }, UndeclaredQuery, {
        override: {
            body?: string;
            coverAlt?: string;
            excerpt?: string;
            seo?: {
                metaDescription?: string;
                metaTitle?: string;
            };
            title?: string;
            version?: number;
        };
    }>;
    'DELETE /api/cms/sites/{siteId}/posts/{postId}/locale/{locale}': Op<{ siteId: string | number; postId: string | number; locale: string | number }>;
    'POST /api/cms/sites/{siteId}/publish': Op<{ siteId: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/cms/sites/{siteId}/redirects': Op<{ siteId: string | number }>;
    'POST /api/cms/sites/{siteId}/redirects': Op<{ siteId: string | number }, UndeclaredQuery, {
        external?: boolean;
        from: string;
        status?: 301 | 302;
        to: string;
    }>;
    'PUT /api/cms/sites/{siteId}/redirects/hosts': Op<{ siteId: string | number }, UndeclaredQuery, {
        hosts: Array<string>;
    }>;
    'DELETE /api/cms/sites/{siteId}/redirects/{id}': Op<{ siteId: string | number; id: string | number }>;
    'POST /api/cms/sites/{siteId}/site/ai-translate/{locale}': Op<{ siteId: string | number; locale: string | number }, UndeclaredQuery, {
        modelTier?: string | null;
    }>;
    'PUT /api/cms/sites/{siteId}/site/locale/{locale}': Op<{ siteId: string | number; locale: string | number }, UndeclaredQuery, {
        override: Record<string, unknown>;
    }>;
    'DELETE /api/cms/sites/{siteId}/site/locale/{locale}': Op<{ siteId: string | number; locale: string | number }>;
    'GET /api/cms/stories': Op;
    'GET /api/compliance/access-audit': Op<NoParams, {
        action?: string | Array<string>;
        actions?: string | Array<string>;
        actor?: string;
        limit?: string;
        offset?: string;
        scope?: string;
        since?: string;
        targetId?: string;
        targetType?: string;
        until?: string;
    }>;
    'GET /api/compliance/access-audit/actions': Op<NoParams, {
        action?: string | Array<string>;
        actions?: string | Array<string>;
        actor?: string;
        limit?: string;
        offset?: string;
        scope?: string;
        since?: string;
        targetId?: string;
        targetType?: string;
        until?: string;
    }>;
    'GET /api/compliance/access-audit/export': Op<NoParams, {
        action?: string | Array<string>;
        actions?: string | Array<string>;
        actor?: string;
        limit?: string;
        offset?: string;
        scope?: string;
        since?: string;
        targetId?: string;
        targetType?: string;
        until?: string;
    }>;
    'GET /api/compliance/ai-act/assessments': Op;
    'GET /api/compliance/ai-act/assessments/{kind}/{id}': Op<{ kind: string | number; id: string | number }>;
    'PUT /api/compliance/ai-act/assessments/{kind}/{id}': Op<{ kind: string | number; id: string | number }, UndeclaredQuery, {
        answers?: Record<string, unknown>;
    }>;
    'GET /api/compliance/ai-act/assessments/{kind}/{id}/signals': Op<{ kind: string | number; id: string | number }>;
    'GET /api/compliance/attention': Op<NoParams, {
        limit?: number;
    }>;
    'POST /api/compliance/auto-detect-settings': Op<NoParams, UndeclaredQuery, Record<string, never>>;
    'GET /api/compliance/calendar': Op<NoParams, {
        all?: '0' | '1' | 'true' | 'false';
    }>;
    'GET /api/compliance/chat-monitoring': Op;
    'PUT /api/compliance/chat-monitoring': Op<NoParams, UndeclaredQuery, {
        acknowledgements?: {
            informed_before_start?: boolean;
            lia_documented?: boolean;
            notice_published?: boolean;
            ropa_reviewed?: boolean;
        };
        dpia_at: string | null;
        dpia_ref: string | null;
        dpia_risk_level: 'low' | 'medium' | 'high' | null;
        dpo_advice_at: string | null;
        effective_from?: string | null;
        enabled: boolean;
        legal_basis: 'art6_1_f' | 'art6_1_e' | 'art6_1_c' | null;
        notice_published_at: string | null;
        notice_url: string | null;
        prior_consultation_at: string | null;
        retention_days: number;
        signals: Array<'outcomes' | 'kinds'>;
        surfaces: Array<'direct' | 'agent' | 'agent_public'>;
        works_council: 'consent' | 'court_replacement' | 'not_applicable' | 'pending' | null;
        works_council_at: string | null;
        works_council_reason: 'no_works_council' | 'pvt_without_consent_right' | 'cao_regulates' | 'outside_nl' | null;
        works_council_scope: {
            max_retention_days: number;
            signals: Array<'outcomes' | 'kinds'>;
            surfaces: Array<'direct' | 'agent' | 'agent_public'>;
        } | null;
    }>;
    'DELETE /api/compliance/chat-monitoring/counts': Op;
    'GET /api/compliance/chat-monitoring/summary': Op<NoParams, {
        days?: '30' | '90';
    }>;
    'GET /api/compliance/checks': Op<NoParams, {
        framework?: string;
    }>;
    'POST /api/compliance/checks/run': Op<NoParams, UndeclaredQuery, Record<string, never>>;
    'POST /api/compliance/checks/{id}/auto-fix': Op<{ id: string | number }, UndeclaredQuery, {
        subjectId?: string | null;
    }>;
    'GET /api/compliance/checks/{id}/history': Op<{ id: string | number }, {
        scope_id?: string;
    }>;
    'POST /api/compliance/checks/{id}/run': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/compliance/checks/{id}/state': Op<{ id: string | number }, UndeclaredQuery, {
        days?: number;
        reason?: string;
        scope_id?: string | null;
        state: 'acknowledged' | 'accepted_risk' | 'snoozed' | 'open';
        until?: string;
    }>;
    'GET /api/compliance/counts': Op<NoParams, {
        keys?: string;
    }>;
    'DELETE /api/compliance/custom/checks/{id}': Op<{ id: string | number }>;
    'POST /api/compliance/custom/checks/{id}/attest': Op<{ id: string | number }, UndeclaredQuery, {
        evidence_refs?: Array<{
            evidence_id?: string | number | null;
            filename?: string | null;
            id?: string | number | null;
            sha256?: string | null;
            [key: string]: unknown;
        }>;
        expires_in_months?: number | null;
        outcome?: string;
        statement?: string | null;
        subject_id?: string | null;
    }>;
    'GET /api/compliance/custom/checks/{id}/attestations': Op<{ id: string | number }, {
        limit?: number;
        subject_id?: string;
    }>;
    'GET /api/compliance/custom/frameworks': Op<NoParams, {
        include_archived?: '0' | '1' | 'true' | 'false';
    }>;
    'POST /api/compliance/custom/frameworks': Op<NoParams, UndeclaredQuery, {
        attestationValidMonths?: number;
        attestation_valid_months?: number;
        code?: string;
        description?: string | null;
        name: string;
        reference?: string | null;
        status?: 'draft' | 'active';
    }>;
    'GET /api/compliance/custom/frameworks/{id}': Op<{ id: string | number }>;
    'PUT /api/compliance/custom/frameworks/{id}': Op<{ id: string | number }, UndeclaredQuery, {
        attestationValidMonths?: number;
        attestation_valid_months?: number;
        code?: string;
        description?: string | null;
        name?: string;
        reference?: string | null;
        status?: 'draft' | 'active';
    }>;
    'DELETE /api/compliance/custom/frameworks/{id}': Op<{ id: string | number }>;
    'POST /api/compliance/custom/frameworks/{id}/checks': Op<{ id: string | number }, UndeclaredQuery, Array<{
        description?: string | null;
        evidenceRequired?: boolean;
        evidence_required?: boolean;
        mappedCheckId?: string | null;
        mapped_check_id?: string | null;
        ref: string;
        severity?: 'low' | 'medium' | 'high' | 'critical' | null;
        sortOrder?: number;
        sort_order?: number;
        title: string;
    }>>;
    'GET /api/compliance/custom/frameworks/{id}/export.json': Op<{ id: string | number }>;
    'GET /api/compliance/deadlines': Op;
    'GET /api/compliance/dpia': Op;
    'GET /api/compliance/dpia/{agentId}': Op<{ agentId: string | number }>;
    'POST /api/compliance/dpia/{agentId}': Op<{ agentId: string | number }, UndeclaredQuery, {
        answers?: Record<string, unknown>;
        expires_at?: string | null;
        mitigations?: Array<string>;
        mode?: 'attestation' | 'questionnaire';
        risk_level?: 'low' | 'medium' | 'high';
    }>;
    'GET /api/compliance/dpia/{agentId}/pdf': Op<{ agentId: string | number }>;
    'GET /api/compliance/evidence': Op<NoParams, {
        limit?: string;
        offset?: string;
        regulation?: string;
        subject_type?: string;
    }>;
    'GET /api/compliance/evidence/chain': Op<NoParams, {
        limit?: string;
    }>;
    'GET /api/compliance/evidence/file/{id}': Op<{ id: string | number }>;
    'GET /api/compliance/evidence/{checkId}': Op<{ checkId: string | number }>;
    'GET /api/compliance/frameworks': Op;
    'POST /api/compliance/frameworks/{id}/disable': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/compliance/frameworks/{id}/enable': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/compliance/frameworks/{id}/relevance': Op<{ id: string | number }, UndeclaredQuery, {
        note?: string | null;
        relevance?: string;
    }>;
    'GET /api/compliance/incidents': Op<NoParams, {
        kind?: string;
        status?: 'open' | 'assessing' | 'early_warning_sent' | 'authority_notified' | 'reported' | 'subjects_notified' | 'closed';
    }>;
    'POST /api/compliance/incidents': Op<NoParams, UndeclaredQuery, {
        actively_exploited?: boolean;
        affected_products?: string | Array<string | {
            name?: string;
            version_range?: string | null;
            [key: string]: unknown;
        }> | null;
        cve_ids?: string | Array<string> | null;
        description?: string | null;
        detected_at?: string | null;
        exploited_in_wild?: boolean;
        high_risk?: boolean;
        kind?: string | null;
        occurred_at?: string | null;
        regimes?: string | Array<string> | null;
        reported_via?: string | null;
        severity?: 'low' | 'medium' | 'high' | 'critical';
        title: string;
    }>;
    'PATCH /api/compliance/incidents/{id}': Op<{ id: string | number }, UndeclaredQuery, {
        authority_reference?: string | null;
        description?: string | null;
        high_risk?: boolean;
        note?: string;
        occurred_at?: string | null;
        severity?: 'low' | 'medium' | 'high' | 'critical';
        status?: 'open' | 'assessing' | 'early_warning_sent' | 'authority_notified' | 'reported' | 'subjects_notified' | 'closed';
        title?: string;
    }>;
    'POST /api/compliance/incidents/{id}/cra-report': Op<{ id: string | number }, UndeclaredQuery, {
        reference?: string | null;
        reported_via?: string | null;
        stage: 'early_warning' | 'full';
    }>;
    'POST /api/compliance/incidents/{id}/customer-notified': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/compliance/incidents/{id}/notify-recipients': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/compliance/iso/audit': Op;
    'GET /api/compliance/iso/audit/independence/{userId}': Op<{ userId: string | number }>;
    'POST /api/compliance/iso/audits': Op<NoParams, UndeclaredQuery, {
        auditor_user_id?: string | null;
        planned_at?: string | null;
        scope_note?: string | null;
        title: string;
    }>;
    'PUT /api/compliance/iso/audits/{id}': Op<{ id: string | number }, UndeclaredQuery, {
        auditor_user_id?: string | null;
        planned_at?: string | null;
        scope_note?: string | null;
        status?: 'planned' | 'in_progress' | 'closed';
        title?: string;
    }>;
    'POST /api/compliance/iso/audits/{id}/findings': Op<{ id: string | number }, UndeclaredQuery, {
        clause?: string | null;
        control_ref?: string | null;
        description: string;
        evidence_ref?: string | null;
        nonconformity_id?: number | string | null;
        severity?: 'observation' | 'minor' | 'major';
    }>;
    'GET /api/compliance/iso/clause-conformity.pdf': Op;
    'GET /api/compliance/iso/connectors': Op;
    'PUT /api/compliance/iso/connectors/{id}': Op<{ id: string | number }, UndeclaredQuery, {
        connection_id?: string | null;
        enabled?: boolean;
        settings?: Record<string, unknown>;
    }>;
    'GET /api/compliance/iso/connectors/{id}/connections': Op<{ id: string | number }>;
    'POST /api/compliance/iso/connectors/{id}/sweep': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/compliance/iso/docs': Op;
    'GET /api/compliance/iso/docs/published/me': Op;
    'GET /api/compliance/iso/docs/published/{slug}/body': Op<{ slug: string | number }>;
    'POST /api/compliance/iso/docs/seed': Op<NoParams, UndeclaredQuery, Record<string, never>>;
    'GET /api/compliance/iso/docs/{slug}': Op<{ slug: string | number }>;
    'PUT /api/compliance/iso/docs/{slug}': Op<{ slug: string | number }, UndeclaredQuery, {
        body?: string;
        owner_user_id?: string | null;
        review_due_at?: string | null;
        title?: string;
    }>;
    'POST /api/compliance/iso/docs/{slug}/acknowledge': Op<{ slug: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/compliance/iso/docs/{slug}/publish': Op<{ slug: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/compliance/iso/evidence-bundle.zip': Op;
    'POST /api/compliance/iso/evidence/upload': Op;
    'POST /api/compliance/iso/ncs': Op<NoParams, UndeclaredQuery, {
        corrective_action?: string | null;
        description?: string | null;
        due_at?: string | null;
        finding_id?: number | string | null;
        owner_user_id?: string | null;
        severity?: 'minor' | 'major';
        source?: 'internal_audit' | 'management_review' | 'incident' | 'check' | 'manual';
        title: string;
    }>;
    'PUT /api/compliance/iso/ncs/{id}': Op<{ id: string | number }, UndeclaredQuery, {
        confirm_effectiveness?: boolean;
        corrective_action?: string | null;
        description?: string | null;
        due_at?: string | null;
        effectiveness_review_due_at?: string | null;
        owner_user_id?: string | null;
        severity?: 'minor' | 'major';
        status?: 'open' | 'corrective_action' | 'effectiveness_review' | 'closed';
        title?: string;
    }>;
    'POST /api/compliance/iso/objectives': Op<NoParams, UndeclaredQuery, {
        measure?: string | null;
        owner_user_id?: string | null;
        review_due_at?: string | null;
        target?: string | null;
        title: string;
    }>;
    'PUT /api/compliance/iso/objectives/{id}': Op<{ id: string | number }, UndeclaredQuery, {
        measure?: string | null;
        owner_user_id?: string | null;
        review_due_at?: string | null;
        status?: 'active' | 'achieved' | 'dropped';
        target?: string | null;
        title?: string;
    }>;
    'POST /api/compliance/iso/obligations': Op<NoParams, UndeclaredQuery, {
        due_at: string;
        kind?: 'policy_review' | 'soa_review' | 'internal_audit' | 'management_review' | 'training' | 'access_review' | 'supplier_review' | 'pentest' | 'custom';
        notify_offsets?: Array<number>;
        owner_user_id?: string | null;
        recur_months?: number | null;
        subject?: string | null;
        title: string;
    }>;
    'PUT /api/compliance/iso/obligations/{id}': Op<{ id: string | number }, UndeclaredQuery, {
        due_at?: string;
        notify_offsets?: Array<number>;
        owner_user_id?: string | null;
        recur_months?: number | null;
        subject?: string | null;
        title?: string;
    }>;
    'POST /api/compliance/iso/obligations/{id}/complete': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/compliance/iso/policy-pack.pdf': Op;
    'GET /api/compliance/iso/readiness': Op;
    'POST /api/compliance/iso/reviews': Op<NoParams, UndeclaredQuery, {
        attendees?: Array<unknown>;
        decisions?: string | null;
        held_at: string;
        inputs?: Record<string, unknown>;
        minutes_evidence_ref?: string | null;
    }>;
    'GET /api/compliance/iso/risks': Op;
    'POST /api/compliance/iso/risks': Op<NoParams, UndeclaredQuery, {
        category?: string | null;
        description?: string | null;
        impact?: number;
        likelihood?: number;
        owner_user_id?: string | null;
        review_due_at?: string | null;
        seed_key?: string | null;
        source?: 'manual' | 'seed' | 'playbook';
        status?: 'open' | 'treating' | 'accepted' | 'closed';
        title: string;
    }>;
    'GET /api/compliance/iso/risks.pdf': Op;
    'POST /api/compliance/iso/risks/seed': Op<NoParams, UndeclaredQuery, Record<string, never>>;
    'PUT /api/compliance/iso/risks/{id}': Op<{ id: string | number }, UndeclaredQuery, {
        category?: string | null;
        description?: string | null;
        impact?: number;
        likelihood?: number;
        owner_user_id?: string | null;
        review_due_at?: string | null;
        status?: 'open' | 'treating' | 'accepted' | 'closed';
        title?: string;
    }>;
    'POST /api/compliance/iso/risks/{id}/treatments': Op<{ id: string | number }, UndeclaredQuery, {
        description?: string | null;
        due_at?: string | null;
        option: 'mitigate' | 'transfer' | 'avoid' | 'accept';
        owner_user_id?: string | null;
    }>;
    'GET /api/compliance/iso/soa': Op;
    'GET /api/compliance/iso/soa.pdf': Op;
    'GET /api/compliance/iso/soa/history': Op<NoParams, {
        limit?: number;
    }>;
    'POST /api/compliance/iso/soa/seed': Op<NoParams, UndeclaredQuery, {
        provider?: string;
    }>;
    'PUT /api/compliance/iso/soa/{ref}': Op<{ ref: string | number }, UndeclaredQuery, {
        applicable?: boolean;
        evidence_ref?: string | null;
        how_met?: string | null;
        justification?: string | null;
        owner_user_id?: string | null;
        source?: 'auto' | 'connector' | 'attest' | 'inherited';
        status?: 'todo' | 'reviewed' | 'approved';
    }>;
    'GET /api/compliance/iso/training': Op;
    'POST /api/compliance/iso/training/{userId}/attest': Op<{ userId: string | number }, UndeclaredQuery, {
        note?: string | null;
    }>;
    'GET /api/compliance/kb-query-log/entries': Op<NoParams, {
        channel?: 'agent_chat' | 'agent_chat_sync' | 'direct_chat' | 'template_chat' | 'notebook' | 'webpage' | 'project_assistant' | 'automation_ai_step' | 'studio_kb_query' | 'studio_ai_generate' | 'studio_ai_extract' | 'studio_ai_chat' | 'support' | 'skill' | 'kb_test' | 'api_search';
        from?: string;
        kbId?: string;
        limit?: number;
        offset?: number;
        outcome?: 'answered' | 'no_results' | 'error';
        status?: 'to_review' | 'reviewed' | 'needs_addition';
        to?: string;
        userId?: string;
    }>;
    'GET /api/compliance/kb-query-log/entries/export.csv': Op<NoParams, {
        channel?: 'agent_chat' | 'agent_chat_sync' | 'direct_chat' | 'template_chat' | 'notebook' | 'webpage' | 'project_assistant' | 'automation_ai_step' | 'studio_kb_query' | 'studio_ai_generate' | 'studio_ai_extract' | 'studio_ai_chat' | 'support' | 'skill' | 'kb_test' | 'api_search';
        from?: string;
        kbId?: string;
        outcome?: 'answered' | 'no_results' | 'error';
        status?: 'to_review' | 'reviewed' | 'needs_addition';
        to?: string;
        userId?: string;
    }>;
    'GET /api/compliance/kb-query-log/overview': Op;
    'GET /api/compliance/kb-query-log/subjects/{userId}': Op<{ userId: string | number }>;
    'DELETE /api/compliance/kb-query-log/subjects/{userId}': Op<{ userId: string | number }, UndeclaredQuery, {
        dsrRequestId: number;
        reason: string;
    }>;
    'GET /api/compliance/kb-query-log/subjects/{userId}/content': Op<{ userId: string | number }, {
        dsrRequestId: number;
        limit?: number;
        offset?: number;
    }>;
    'GET /api/compliance/kb-query-log/subjects/{userId}/export': Op<{ userId: string | number }, {
        dsrRequestId: number;
        format?: 'json' | 'csv';
    }>;
    'GET /api/compliance/machinery/detections': Op;
    'POST /api/compliance/machinery/subjects/{id}/attest': Op<{ id: string | number }, UndeclaredQuery, {
        classification?: string;
        evidence_refs?: Array<{
            evidence_id?: string | number | null;
            filename?: string | null;
            id?: string | number | null;
            sha256?: string | null;
            [key: string]: unknown;
        }>;
        outcome?: string;
        statement?: string | null;
    }>;
    'GET /api/compliance/machinery/subjects/{id}/attestations': Op<{ id: string | number }>;
    'GET /api/compliance/org-users': Op;
    'GET /api/compliance/overview': Op;
    'GET /api/compliance/portability': Op;
    'GET /api/compliance/registry': Op;
    'GET /api/compliance/report.pdf': Op;
    'GET /api/compliance/ropa': Op;
    'GET /api/compliance/ropa.pdf': Op;
    'GET /api/compliance/ropa/projects': Op;
    'PUT /api/compliance/ropa/projects/{projectId}': Op<{ projectId: string | number }, UndeclaredQuery, {
        lawful_basis: 'consent' | 'contract' | 'legal_obligation' | 'vital_interests' | 'public_task' | 'legitimate_interests';
        purpose?: string | null;
        retention_days?: number | null;
    }>;
    'DELETE /api/compliance/ropa/projects/{projectId}': Op<{ projectId: string | number }>;
    'POST /api/compliance/ropa/review': Op<NoParams, UndeclaredQuery, Record<string, never>>;
    'GET /api/compliance/sbom': Op;
    'GET /api/compliance/sbom/meta': Op;
    'GET /api/compliance/score-history': Op<NoParams, {
        days?: number;
    }>;
    'GET /api/compliance/settings': Op;
    'PUT /api/compliance/settings': Op;
    'POST /api/compliance/settings/onboarded': Op;
    'POST /api/compliance/settings/scc': Op<NoParams, UndeclaredQuery, {
        confirmed?: boolean;
        operator: string;
    }>;
    'GET /api/cowork': Op;
    'POST /api/cowork': Op<NoParams, UndeclaredQuery, {
        agentId?: string | null;
        daysOfWeek?: Array<string> | null;
        enabledApps?: Array<string> | null;
        modelTier?: string | null;
        nextRunAt?: string;
        prompt: string;
        repeatInterval?: 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly' | null;
        startNow?: boolean;
        timeOfDay?: string | null;
        timezone?: string | null;
        title: string;
        trigger?: {
            event: 'mail.new';
            filter?: Record<string, unknown> | null;
            provider: 'gmail' | 'msgraph';
        } | null;
        triggerKind?: 'schedule' | 'app_event';
    }>;
    'POST /api/cowork/compose': Op<NoParams, UndeclaredQuery, {
        brief: string;
        timezone?: string | null;
    }>;
    'GET /api/cowork/mail-providers': Op;
    'GET /api/cowork/{id}': Op<{ id: string | number }>;
    'PUT /api/cowork/{id}': Op<{ id: string | number }, UndeclaredQuery, {
        agentId?: string | null;
        daysOfWeek?: Array<string> | null;
        enabledApps?: Array<string> | null;
        isActive?: boolean;
        modelTier?: string | null;
        nextRunAt?: string;
        prompt?: string;
        repeatInterval?: 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly' | null;
        timeOfDay?: string | null;
        timezone?: string | null;
        title?: string;
        trigger?: {
            event: 'mail.new';
            filter?: Record<string, unknown> | null;
            provider: 'gmail' | 'msgraph';
        } | null;
        triggerKind?: 'schedule' | 'app_event';
    }>;
    'DELETE /api/cowork/{id}': Op<{ id: string | number }>;
    'POST /api/cowork/{id}/run-now': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/cowork/{id}/runs': Op<{ id: string | number }, {
        limit?: number;
        offset?: number;
    }>;
    'GET /api/cowork/{id}/stats': Op<{ id: string | number }>;
    'POST /api/cowork/{id}/toggle': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/csp-report': Op;
    'GET /api/datatables': Op;
    'POST /api/datatables': Op<NoParams, UndeclaredQuery, {
        description: string;
        fields?: Array<unknown>;
        key: string;
        name: string;
        projectId?: string | null;
        rowScope?: 'all' | 'own';
        scope?: string;
    }>;
    'POST /api/datatables/ai/draft': Op<NoParams, UndeclaredQuery, {
        allowDestructive?: boolean;
        brief?: string | null;
        current?: Record<string, unknown> | null;
        mode?: 'create' | 'revise';
        note?: string | null;
    }>;
    'POST /api/datatables/managed': Op<NoParams, UndeclaredQuery, {
        description?: string;
        key: string;
        kind: string;
        name: string;
        retentionDays?: number;
        scope?: string;
    }>;
    'GET /api/datatables/nextcloud/describe': Op<NoParams, {
        ncTableId?: string;
        ncViewId?: string;
        scope?: string;
    }>;
    'POST /api/datatables/nextcloud/link': Op<NoParams, UndeclaredQuery, {
        relations?: Array<Record<string, unknown>>;
        schedule?: unknown;
        scope?: string;
        tables?: Array<{
            description?: string;
            key?: string;
            name?: string;
            ncTableId?: number | null;
            ncViewId?: number | null;
        }>;
    }>;
    'GET /api/datatables/nextcloud/linkable': Op<NoParams, {
        scope?: string;
    }>;
    'GET /api/datatables/spreadsheets/browse': Op<NoParams, {
        folderId?: string;
        pageToken?: string;
        provider?: string;
        q?: string;
        scope?: string;
        shared?: '0' | '1' | 'true' | 'false';
    }>;
    'GET /api/datatables/spreadsheets/describe': Op<NoParams, {
        driveId?: string;
        fileId?: string;
        headerRow?: string;
        path?: string;
        provider?: string;
        scope?: string;
        sheet?: string;
    }>;
    'POST /api/datatables/spreadsheets/link': Op<NoParams, UndeclaredQuery, {
        relations?: Array<Record<string, unknown>>;
        scope?: string;
        tables?: Array<{
            columns?: Array<{
                col: number;
                header?: string | number | null;
                type?: string | null;
            }>;
            description?: string;
            driveId?: string | null;
            fileId?: string;
            headerRow?: number | null;
            key?: string;
            keyColumn?: number | null;
            name?: string;
            path?: string | null;
            provider?: string;
            sharedWriteOptIn?: boolean;
            sheet?: string | null;
        }>;
    }>;
    'GET /api/datatables/spreadsheets/providers': Op<NoParams, {
        scope?: string;
    }>;
    'GET /api/datatables/{id}': Op<{ id: string | number }>;
    'PATCH /api/datatables/{id}': Op<{ id: string | number }, UndeclaredQuery, {
        description?: string;
        lawfulBasis?: 'consent' | 'contract' | 'legal_obligation' | 'vital_interests' | 'public_task' | 'legitimate_interests' | null;
        name?: string;
        retentionDays?: number | null;
        retentionField?: string;
        rowScope?: 'all' | 'own';
        subjectColumn?: string | null;
        [key: string]: unknown;
    }>;
    'DELETE /api/datatables/{id}': Op<{ id: string | number }, {
        confirmBreaking?: '0' | '1' | 'true' | 'false';
    }, {
        confirmBreaking?: boolean;
    }>;
    'POST /api/datatables/{id}/aggregate': Op<{ id: string | number }, UndeclaredQuery, {
        aggregates?: unknown;
        filters?: unknown;
        groupBy?: unknown;
        limit?: unknown;
        match?: unknown;
        sort?: unknown;
    }>;
    'DELETE /api/datatables/{id}/answers/columns/{fieldId}': Op<{ id: string | number; fieldId: string | number }, {
        confirmBreaking?: '0' | '1' | 'true' | 'false';
    }>;
    'POST /api/datatables/{id}/answers/release': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/datatables/{id}/answers/summary': Op<{ id: string | number }, {
        from?: string;
        to?: string;
    }>;
    'GET /api/datatables/{id}/grants': Op<{ id: string | number }>;
    'POST /api/datatables/{id}/grants': Op<{ id: string | number }, UndeclaredQuery, {
        grade: 'viewer' | 'editor';
        granteeId: string;
        granteeType: 'user' | 'group';
    }>;
    'DELETE /api/datatables/{id}/grants/{grantId}': Op<{ id: string | number; grantId: string | number }>;
    'GET /api/datatables/{id}/health': Op<{ id: string | number }>;
    'GET /api/datatables/{id}/nextcloud': Op<{ id: string | number }>;
    'PUT /api/datatables/{id}/nextcloud': Op<{ id: string | number }>;
    'GET /api/datatables/{id}/nextcloud/pulse': Op<{ id: string | number }>;
    'POST /api/datatables/{id}/nextcloud/refresh': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'PUT /api/datatables/{id}/nextcloud/relations': Op<{ id: string | number }, UndeclaredQuery, {
        relations?: unknown;
    }>;
    'POST /api/datatables/{id}/nextcloud/relink': Op<{ id: string | number }>;
    'POST /api/datatables/{id}/repair': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/datatables/{id}/rows': Op<{ id: string | number }, {
        cursor?: string;
        dir?: 'asc' | 'desc';
        filters?: string;
        limit?: number;
        match?: 'all' | 'any';
        q?: string;
        sort?: string;
    }>;
    'POST /api/datatables/{id}/rows': Op<{ id: string | number }, UndeclaredQuery, {
        values: Record<string, unknown>;
    }>;
    'GET /api/datatables/{id}/rows.csv': Op<{ id: string | number }>;
    'POST /api/datatables/{id}/rows/bulk': Op<{ id: string | number }, UndeclaredQuery, {
        rows: Array<unknown>;
    }>;
    'POST /api/datatables/{id}/rows/bulk-delete': Op<{ id: string | number }, UndeclaredQuery, {
        ids: Array<string>;
    }>;
    'GET /api/datatables/{id}/rows/{rowId}': Op<{ id: string | number; rowId: string | number }>;
    'PUT /api/datatables/{id}/rows/{rowId}': Op<{ id: string | number; rowId: string | number }, UndeclaredQuery, {
        expectedUpdatedAt: string;
        values: Record<string, unknown>;
    }>;
    'DELETE /api/datatables/{id}/rows/{rowId}': Op<{ id: string | number; rowId: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/datatables/{id}/schema': Op<{ id: string | number }>;
    'PUT /api/datatables/{id}/schema': Op<{ id: string | number }, {
        confirmBreaking?: '0' | '1' | 'true' | 'false';
    }, {
        confirmBreaking?: boolean;
        expectedVersion?: number | string;
        fields: Array<unknown>;
    }>;
    'PUT /api/datatables/{id}/sharing': Op<{ id: string | number }, UndeclaredQuery, {
        audience?: string;
        isPublished?: boolean;
        sharedGroups?: Array<unknown>;
        writeMode?: 'grants' | 'audience';
    }>;
    'GET /api/datatables/{id}/source': Op<{ id: string | number }>;
    'PUT /api/datatables/{id}/source': Op<{ id: string | number }>;
    'GET /api/datatables/{id}/source/pulse': Op<{ id: string | number }>;
    'POST /api/datatables/{id}/source/refresh': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'PUT /api/datatables/{id}/source/relations': Op<{ id: string | number }, UndeclaredQuery, {
        relations?: unknown;
    }>;
    'POST /api/datatables/{id}/source/relink': Op<{ id: string | number }>;
    'GET /api/datatables/{id}/usage': Op<{ id: string | number }>;
    'POST /api/dictate': Op<NoParams, UndeclaredQuery, {
        language?: string;
    }>;
    'GET /api/dictate/status': Op;
    'GET /api/documents/download/{filename}': Op<{ filename: string | number }>;
    'GET /api/documents/list': Op;
    'GET /api/documents/view/{filename}': Op<{ filename: string | number }>;
    'GET /api/dsr/requests': Op<NoParams, {
        status?: 'pending' | 'in_progress' | 'fulfilled' | 'rejected';
    }>;
    'POST /api/dsr/requests': Op<NoParams, UndeclaredQuery, {
        notes?: string;
        request_type?: string;
        subject_email: string;
    }>;
    'POST /api/dsr/requests/manual': Op<NoParams, UndeclaredQuery, {
        channel?: string;
        notes?: string | null;
        received_at?: string | null;
        request_type?: string;
        subject_email: string;
    }>;
    'POST /api/dsr/requests/verify': Op;
    'GET /api/dsr/requests/{id}': Op<{ id: string | number }>;
    'GET /api/dsr/requests/{id}/discovery': Op<{ id: string | number }, {
        force?: '0' | '1';
    }>;
    'GET /api/dsr/requests/{id}/export': Op<{ id: string | number }>;
    'POST /api/dsr/requests/{id}/extend': Op<{ id: string | number }, UndeclaredQuery, {
        reason?: string;
    }>;
    'POST /api/dsr/requests/{id}/fulfil': Op<{ id: string | number }, UndeclaredQuery, {
        notify_subject?: boolean;
        result_payload?: Record<string, unknown> | null;
        result_summary?: string | null;
        status?: string;
    }>;
    'GET /api/dsr/requests/{id}/public': Op<{ id: string | number }>;
    'POST /api/dsr/requests/{id}/start': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/dsr/requests/{id}/timeline': Op<{ id: string | number }>;
    'POST /api/dsr/requests/{id}/verify': Op<{ id: string | number }>;
    'POST /api/dsr/requests/{id}/verify-identity': Op<{ id: string | number }, UndeclaredQuery, {
        method?: string;
        note?: string;
    }>;
    'GET /api/feedback': Op<NoParams, {
        agentId?: string;
        endDate?: string;
        limit?: number;
        rating?: 'up' | 'down';
        reveal?: 'true' | 'false';
        source?: 'agent' | 'direct';
        startDate?: string;
    }>;
    'POST /api/feedback': Op<NoParams, UndeclaredQuery, {
        agentId?: string | null;
        agentName?: string | null;
        comment?: string | null;
        conversationId?: string | null;
        conversationSnapshot?: Array<Record<string, unknown>> | null;
        messageId: string;
        model?: string | null;
        modelTier?: string | null;
        rating: 'up' | 'down';
        source?: 'agent' | 'direct';
    }>;
    'GET /api/feedback/org': Op<NoParams, {
        agentId?: string;
        endDate?: string;
        limit?: number;
        orgId?: string;
        rating?: 'up' | 'down';
        reveal?: 'true' | 'false';
        source?: 'agent' | 'direct';
        startDate?: string;
    }>;
    'GET /api/feedback/org/summary': Op<NoParams, {
        endDate?: string;
        orgId?: string;
        startDate?: string;
    }>;
    'GET /api/feedback/summary': Op<NoParams, {
        endDate?: string;
        startDate?: string;
    }>;
    'GET /api/gmeet-notes-settings/user/me': Op;
    'PUT /api/gmeet-notes-settings/user/me': Op<NoParams, UndeclaredQuery, {
        autoImport?: boolean | null;
        autoRecordConfig?: boolean | null;
        excludedEventIds?: Array<string>;
        excludedMeetingCodes?: Array<string>;
        importScope?: 'organizer' | 'calendar' | null;
        language?: string | null;
        lookbackHours?: number | null;
        updatedAt?: string | null;
        updatedBy?: string | null;
    }>;
    'GET /api/gmeet-notes-settings/{orgId}': Op<{ orgId: string | number }>;
    'PUT /api/gmeet-notes-settings/{orgId}': Op<{ orgId: string | number }, UndeclaredQuery, {
        autoImport?: boolean | null;
        autoRecordConfig?: boolean | null;
        excludedEventIds?: Array<string>;
        excludedMeetingCodes?: Array<string>;
        importScope?: 'organizer' | 'calendar' | null;
        language?: string | null;
        lookbackHours?: number | null;
        updatedAt?: string | null;
        updatedBy?: string | null;
    }>;
    'GET /api/guard/health': Op;
    'GET /api/health': Op;
    'GET /api/health/schema': Op;
    'GET /api/house-styles/{orgId}': Op<{ orgId: string | number }>;
    'POST /api/house-styles/{orgId}': Op<{ orgId: string | number }, UndeclaredQuery, {
        description?: string;
        isDefault?: 'true' | 'false';
        name?: string;
    }>;
    'GET /api/house-styles/{orgId}/default': Op<{ orgId: string | number }>;
    'GET /api/house-styles/{orgId}/{id}': Op<{ orgId: string | number; id: string | number }>;
    'PATCH /api/house-styles/{orgId}/{id}': Op<{ orgId: string | number; id: string | number }, UndeclaredQuery, {
        description?: string | null;
        isDefault?: boolean;
        name?: string;
        reExtract?: boolean;
    }>;
    'DELETE /api/house-styles/{orgId}/{id}': Op<{ orgId: string | number; id: string | number }>;
    'GET /api/house-styles/{orgId}/{id}/source.docx': Op<{ orgId: string | number; id: string | number }>;
    'GET /api/icons': Op;
    'POST /api/icons': Op<NoParams, UndeclaredQuery, {
        icons?: Record<string, {
            type: 'emoji' | 'image';
            value: string;
        }>;
        name: string;
    }>;
    'GET /api/icons/catalog': Op;
    'POST /api/icons/generate': Op<NoParams, UndeclaredQuery, {
        aspectRatio?: string;
        model?: string | null;
        prompt: string;
        style?: string;
    }>;
    'POST /api/icons/import': Op<NoParams, UndeclaredQuery, {
        exportedAt?: string;
        icons: Record<string, {
            type: 'emoji' | 'image';
            value: string;
        }>;
        kind?: 'beeflow.iconpack';
        name?: string | null;
        version?: 1;
    }>;
    'POST /api/icons/upload': Op;
    'PUT /api/icons/{id}': Op<{ id: string | number }, UndeclaredQuery, {
        icons?: Record<string, {
            type: 'emoji' | 'image';
            value: string;
        }>;
        name?: string;
    }>;
    'DELETE /api/icons/{id}': Op<{ id: string | number }>;
    'POST /api/icons/{id}/activate': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/icons/{id}/bulk-generate': Op<{ id: string | number }, UndeclaredQuery, {
        model?: string | null;
        only?: Array<string>;
        overwrite?: boolean;
        style?: string;
    }>;
    'GET /api/icons/{id}/export': Op<{ id: string | number }>;
    'PATCH /api/icons/{id}/icons/{key}': Op<{ id: string | number; key: string | number }, UndeclaredQuery, {
        type?: 'emoji' | 'image';
        value?: string;
    }>;
    'POST /api/integrations/calendar/execute': Op<NoParams, UndeclaredQuery, {
        _provider?: 'google' | 'microsoft';
        action: 'create' | 'update' | 'delete';
        addGoogleMeet?: boolean | null;
        allDay?: boolean | null;
        attendees?: string | null;
        description?: string | null;
        endTime?: string | null;
        eventId?: string | null;
        isOnlineMeeting?: boolean | null;
        location?: string | null;
        startTime?: string | null;
        timeZone?: string | null;
        title?: string | null;
    }>;
    'GET /api/integrations/connections': Op<NoParams, {
        includeShared?: '0' | '1' | 'true' | 'false';
        provider?: string;
    }>;
    'POST /api/integrations/connections': Op<NoParams, UndeclaredQuery, {
        kind?: 'oauth' | 'api_key' | 'basic' | 'mcp' | 'bearer' | 'oauth2_cc';
        label?: string;
        makeDefault?: boolean;
        provider: string;
        secret?: Record<string, unknown> | null;
        secretMeta?: Record<string, unknown> | null;
    }>;
    'GET /api/integrations/connections/grants': Op<NoParams, {
        connectionId?: string;
        mine?: 'outgoing' | 'incoming';
        resourceId?: string;
        resourceType?: 'agent' | 'webpage' | 'skill' | 'automation' | 'studio_app';
    }>;
    'DELETE /api/integrations/connections/grants/{grantId}': Op<{ grantId: string | number }>;
    'GET /api/integrations/connections/required': Op<NoParams, {
        providers?: string;
        resourceId?: string | null;
        resourceType?: 'agent' | 'webpage' | 'skill' | 'automation' | 'studio_app' | null;
    }>;
    'PATCH /api/integrations/connections/{id}': Op<{ id: string | number }, UndeclaredQuery, {
        label?: string;
        makeDefault?: boolean;
        secret?: Record<string, unknown> | null;
        secretMeta?: Record<string, unknown> | null;
    }>;
    'DELETE /api/integrations/connections/{id}': Op<{ id: string | number }, {
        force?: '0' | '1' | 'true' | 'false';
    }>;
    'POST /api/integrations/connections/{id}/grants': Op<{ id: string | number }, UndeclaredQuery, {
        expiresAt?: string | null;
        granteeEmail?: string | null;
        granteeId?: string | null;
        granteeType: 'user' | 'group' | 'org';
        resourceId?: string | null;
        resourceType?: 'agent' | 'webpage' | 'skill' | 'automation' | 'studio_app' | null;
    }>;
    'POST /api/integrations/contacts/execute': Op<NoParams, UndeclaredQuery, {
        _provider?: 'google' | 'microsoft';
        action: 'create' | 'update';
        company?: string | null;
        companyName?: string | null;
        contactId?: string | null;
        email?: string | null;
        emailAddress?: string | null;
        firstName?: string | null;
        givenName?: string | null;
        jobTitle?: string | null;
        lastName?: string | null;
        notes?: string | null;
        phone?: string | null;
        resourceName?: string | null;
        surname?: string | null;
    }>;
    'GET /api/integrations/gamma/generations/{generationId}': Op<{ generationId: string | number }>;
    'GET /api/integrations/gdrive/export/{fileId}': Op<{ fileId: string | number }>;
    'GET /api/integrations/gdrive/files': Op<NoParams, {
        pageSize?: number;
        pageToken?: string;
        query?: string;
    }>;
    'GET /api/integrations/gdrive/status': Op;
    'POST /api/integrations/github-sync/configure': Op<NoParams, UndeclaredQuery, {
        autoSync?: boolean;
        branch?: string;
        repoName: string;
        repoOwner: string;
    }>;
    'DELETE /api/integrations/github-sync/configure': Op;
    'GET /api/integrations/github-sync/details': Op;
    'POST /api/integrations/github-sync/push': Op<NoParams, UndeclaredQuery, Record<string, never>>;
    'POST /api/integrations/github-sync/push-pending': Op<NoParams, UndeclaredQuery, Record<string, never>>;
    'GET /api/integrations/github-sync/status': Op;
    'POST /api/integrations/github/connect': Op<NoParams, UndeclaredQuery, {
        token: string;
    }>;
    'POST /api/integrations/github/disconnect': Op<NoParams, UndeclaredQuery, Record<string, never>>;
    'GET /api/integrations/github/status': Op;
    'POST /api/integrations/gmail/draft': Op<NoParams, UndeclaredQuery, {
        bcc?: string | null;
        body: string;
        cc?: string | null;
        inReplyTo?: string | null;
        references?: string | null;
        replyToMessageId?: string | null;
        subject: string;
        threadId?: string | null;
        to: string;
    }>;
    'GET /api/integrations/gmail/messages': Op<NoParams, {
        label?: string;
        pageSize?: number;
        pageToken?: string;
        query?: string;
    }>;
    'GET /api/integrations/gmail/messages/{messageId}': Op<{ messageId: string | number }>;
    'POST /api/integrations/gmail/send': Op<NoParams, UndeclaredQuery, {
        bcc?: string | null;
        body: string;
        cc?: string | null;
        inReplyTo?: string | null;
        references?: string | null;
        replyToMessageId?: string | null;
        subject: string;
        threadId?: string | null;
        to: string;
    }>;
    'GET /api/integrations/gmail/status': Op;
    'GET /api/integrations/google/auth-url': Op;
    'GET /api/integrations/google/callback': Op;
    'POST /api/integrations/google/disconnect': Op<NoParams, UndeclaredQuery, Record<string, never>>;
    'GET /api/integrations/google/status': Op;
    'POST /api/integrations/keep/execute': Op<NoParams, UndeclaredQuery, {
        action: 'create' | 'delete';
        content?: string | null;
        listItems?: Array<{
            checked?: boolean;
            text: string;
        }> | null;
        noteId?: string | null;
        title?: string | null;
        type?: 'text' | 'list';
    }>;
    'GET /api/integrations/linkedin/auth-url': Op;
    'GET /api/integrations/linkedin/callback': Op;
    'POST /api/integrations/linkedin/disconnect': Op<NoParams, UndeclaredQuery, Record<string, never>>;
    'POST /api/integrations/linkedin/post': Op<NoParams, UndeclaredQuery, {
        text: string;
    }>;
    'GET /api/integrations/linkedin/status': Op;
    'GET /api/integrations/microsoft/auth-url': Op;
    'GET /api/integrations/microsoft/callback': Op;
    'POST /api/integrations/microsoft/disconnect': Op<NoParams, UndeclaredQuery, Record<string, never>>;
    'GET /api/integrations/microsoft/status': Op;
    'GET /api/integrations/nmbrs/auth-url': Op;
    'GET /api/integrations/nmbrs/callback': Op;
    'POST /api/integrations/nmbrs/disconnect': Op<NoParams, UndeclaredQuery, Record<string, never>>;
    'GET /api/integrations/nmbrs/status': Op;
    'GET /api/integrations/onedrive/export/{fileId}': Op<{ fileId: string | number }>;
    'GET /api/integrations/onedrive/files': Op<NoParams, {
        folderId?: string;
        search?: string;
        top?: number;
    }>;
    'GET /api/integrations/onedrive/status': Op;
    'POST /api/integrations/outlook/draft': Op<NoParams, UndeclaredQuery, {
        _provider?: 'microsoft';
        bcc?: string | null;
        body: string;
        cc?: string | null;
        conversationId?: string | null;
        mailbox?: string | null;
        replyToMessageId?: string | null;
        subject: string;
        to: string;
    }>;
    'GET /api/integrations/outlook/messages': Op<NoParams, {
        folder?: string;
        search?: string;
        top?: number;
    }>;
    'GET /api/integrations/outlook/messages/{id}': Op<{ id: string | number }>;
    'POST /api/integrations/outlook/send': Op<NoParams, UndeclaredQuery, {
        _provider?: 'microsoft';
        bcc?: string | null;
        body: string;
        cc?: string | null;
        conversationId?: string | null;
        mailbox?: string | null;
        replyToMessageId?: string | null;
        subject: string;
        to: string;
    }>;
    'GET /api/integrations/outlook/status': Op;
    'GET /api/integrations/withings/auth-url': Op;
    'GET /api/integrations/withings/callback': Op;
    'POST /api/integrations/withings/disconnect': Op<NoParams, UndeclaredQuery, Record<string, never>>;
    'GET /api/integrations/withings/status': Op;
    'GET /api/kb': Op<NoParams, {
        context?: 'agent' | 'direct_chat' | 'ai_step' | 'webpage';
        excludeContext?: 'agent' | 'direct_chat' | 'ai_step' | 'webpage';
        includeAuto?: '0' | '1' | 'true' | 'false';
        t?: string;
    }>;
    'POST /api/kb': Op<NoParams, UndeclaredQuery, {
        categoryId?: string | null;
        description?: string | null;
        icon?: string | null;
        name: string;
        organizationId?: string | null;
        usageContexts?: Array<string> | null;
    }>;
    'GET /api/kb/categories': Op;
    'POST /api/kb/categories': Op<NoParams, UndeclaredQuery, {
        color?: string | null;
        icon?: string;
        name: string;
    }>;
    'DELETE /api/kb/categories/{id}': Op<{ id: string | number }>;
    'GET /api/kb/cloud/browse': Op<NoParams, {
        driveId?: string;
        pageToken?: string;
        parentId?: string;
        path?: string;
        provider: 'nextcloud_files' | 'onedrive' | 'google_drive';
        q?: string;
    }>;
    'GET /api/kb/cloud/providers': Op;
    'GET /api/kb/favorites': Op;
    'POST /api/kb/favorites/bulk': Op<NoParams, UndeclaredQuery, {
        kbIds: Array<string>;
    }>;
    'GET /api/kb/n8n/ingestible': Op;
    'GET /api/kb/published': Op<NoParams, {
        context?: 'agent' | 'direct_chat' | 'ai_step' | 'webpage';
        excludeContext?: 'agent' | 'direct_chat' | 'ai_step' | 'webpage';
        includeAuto?: '0' | '1' | 'true' | 'false';
        t?: string;
    }>;
    'POST /api/kb/query-log/acknowledge': Op<NoParams, UndeclaredQuery, {
        kbIds: Array<string>;
    }>;
    'GET /api/kb/query-log/dpias': Op;
    'GET /api/kb/query-log/notice': Op<NoParams, {
        kbIds: string;
    }>;
    'POST /api/kb/search': Op<NoParams, UndeclaredQuery, {
        kb_ids?: Array<string> | null;
        query: string;
        top_k?: number | null;
    }>;
    'GET /api/kb/suggestions': Op;
    'GET /api/kb/system': Op;
    'GET /api/kb/usage-summary': Op;
    'GET /api/kb/{id}': Op<{ id: string | number }>;
    'PATCH /api/kb/{id}': Op<{ id: string | number }, UndeclaredQuery, {
        categoryId?: string | null;
        description?: string;
        icon?: string;
        keepOriginals?: boolean;
        name?: string;
        organizationId?: string | null;
        usageContexts?: Array<'agent' | 'direct_chat' | 'ai_step' | 'webpage'>;
    }>;
    'DELETE /api/kb/{id}': Op<{ id: string | number }, {
        confirm?: '0' | '1' | 'true' | 'false';
    }, Record<string, never>>;
    'POST /api/kb/{id}/ask': Op<{ id: string | number }, UndeclaredQuery, {
        question: string;
    }>;
    'GET /api/kb/{id}/documents': Op<{ id: string | number }, {
        dateFrom?: string;
        dateTo?: string;
        hasAttachment?: 'true' | 'false';
        limit?: string;
        offset?: string;
        pii?: string;
        q?: string;
        sender?: string;
        sourceId?: string;
        sourceType?: string;
        status?: string;
        threadId?: string;
    }>;
    'POST /api/kb/{id}/documents/bulk-delete': Op<{ id: string | number }, UndeclaredQuery, {
        documentIds: Array<string>;
    }>;
    'DELETE /api/kb/{id}/documents/{docId}': Op<{ id: string | number; docId: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/kb/{id}/documents/{docId}/chunks': Op<{ id: string | number; docId: string | number }, {
        limit?: string;
    }>;
    'GET /api/kb/{id}/documents/{docId}/content': Op<{ id: string | number; docId: string | number }>;
    'GET /api/kb/{id}/documents/{docId}/original': Op<{ id: string | number; docId: string | number }>;
    'POST /api/kb/{id}/duplicate': Op<{ id: string | number }, {
        withSources?: string;
    }>;
    'PUT /api/kb/{id}/favorite': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'DELETE /api/kb/{id}/favorite': Op<{ id: string | number }>;
    'POST /api/kb/{id}/ingest/file': Op<{ id: string | number }>;
    'POST /api/kb/{id}/ingest/n8n': Op<{ id: string | number }, UndeclaredQuery, {
        mode?: 'data' | 'definition';
        workflowId: string;
    }>;
    'POST /api/kb/{id}/ingest/sitemap': Op<{ id: string | number }, UndeclaredQuery, {
        maxPages?: number;
        url: string;
    }>;
    'POST /api/kb/{id}/ingest/text': Op<{ id: string | number }, UndeclaredQuery, {
        content: string;
        title?: string;
    }>;
    'POST /api/kb/{id}/ingest/url': Op<{ id: string | number }, UndeclaredQuery, {
        url: string;
    }>;
    'PATCH /api/kb/{id}/publish': Op<{ id: string | number }, UndeclaredQuery, {
        isPublished: boolean;
        sharedGroups?: Array<string> | null;
    }>;
    'GET /api/kb/{id}/query-log': Op<{ id: string | number }, {
        channel?: 'agent_chat' | 'agent_chat_sync' | 'direct_chat' | 'template_chat' | 'notebook' | 'webpage' | 'project_assistant' | 'automation_ai_step' | 'studio_kb_query' | 'studio_ai_generate' | 'studio_ai_extract' | 'studio_ai_chat' | 'support' | 'skill' | 'kb_test' | 'api_search';
        from?: string;
        limit?: number;
        offset?: number;
        outcome?: 'answered' | 'no_results' | 'error';
        q?: string;
        status?: 'to_review' | 'reviewed' | 'needs_addition';
        to?: string;
        userId?: string;
    }>;
    'DELETE /api/kb/{id}/query-log': Op<{ id: string | number }>;
    'GET /api/kb/{id}/query-log/export.csv': Op<{ id: string | number }, {
        channel?: 'agent_chat' | 'agent_chat_sync' | 'direct_chat' | 'template_chat' | 'notebook' | 'webpage' | 'project_assistant' | 'automation_ai_step' | 'studio_kb_query' | 'studio_ai_generate' | 'studio_ai_extract' | 'studio_ai_chat' | 'support' | 'skill' | 'kb_test' | 'api_search';
        from?: string;
        outcome?: 'answered' | 'no_results' | 'error';
        q?: string;
        status?: 'to_review' | 'reviewed' | 'needs_addition';
        to?: string;
        userId?: string;
    }>;
    'GET /api/kb/{id}/query-log/settings': Op<{ id: string | number }>;
    'PUT /api/kb/{id}/query-log/settings': Op<{ id: string | number }, UndeclaredQuery, {
        aiActHighRisk?: boolean;
        attestation?: Record<string, unknown>;
        deleteExisting?: boolean;
        enabled: boolean;
        retentionDays?: number;
        showNames?: boolean;
    }>;
    'GET /api/kb/{id}/query-log/{entryId}': Op<{ id: string | number; entryId: string | number }>;
    'PATCH /api/kb/{id}/query-log/{entryId}/review': Op<{ id: string | number; entryId: string | number }, UndeclaredQuery, {
        note?: string | null;
        status: 'to_review' | 'reviewed' | 'needs_addition';
    }>;
    'POST /api/kb/{id}/reindex': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/kb/{id}/sources': Op<{ id: string | number }>;
    'POST /api/kb/{id}/sources': Op<{ id: string | number }, UndeclaredQuery, {
        config?: unknown;
        kind: string;
        name?: string;
        refresh?: {
            cron?: string | null;
            mode?: 'manual' | 'schedule' | 'on_change' | 'live' | 'after_meeting';
            tz?: string | null;
        };
    }>;
    'PATCH /api/kb/{id}/sources/{sid}': Op<{ id: string | number; sid: string | number }, UndeclaredQuery, {
        name?: string;
        refresh?: {
            cron?: string | null;
            mode?: 'manual' | 'schedule' | 'on_change' | 'live' | 'after_meeting';
            tz?: string | null;
        };
    }>;
    'DELETE /api/kb/{id}/sources/{sid}': Op<{ id: string | number; sid: string | number }>;
    'GET /api/kb/{id}/sources/{sid}/documents': Op<{ id: string | number; sid: string | number }, {
        limit?: number;
        offset?: number;
        pii?: string;
        q?: string;
        status?: string;
    }>;
    'GET /api/kb/{id}/sources/{sid}/documents/{docId}': Op<{ id: string | number; sid: string | number; docId: string | number }>;
    'POST /api/kb/{id}/sources/{sid}/files': Op<{ id: string | number; sid: string | number }>;
    'POST /api/kb/{id}/sources/{sid}/refresh': Op<{ id: string | number; sid: string | number }>;
    'GET /api/kb/{id}/threads': Op<{ id: string | number }, {
        limit?: string;
    }>;
    'GET /api/kb/{id}/threads/{threadId}/documents': Op<{ id: string | number; threadId: string | number }>;
    'GET /api/kb/{id}/usage': Op<{ id: string | number }>;
    'GET /api/languages': Op;
    'POST /api/languages': Op<NoParams, UndeclaredQuery, {
        code: string;
        name: string;
    }>;
    'GET /api/languages/defaults/gui': Op;
    'GET /api/languages/defaults/prompts': Op;
    'GET /api/languages/org/default': Op;
    'PUT /api/languages/org/default': Op<NoParams, UndeclaredQuery, {
        defaultLocale: string;
    }>;
    'GET /api/languages/public/locales': Op;
    'GET /api/languages/public/strings/{locale}': Op<{ locale: string | number }>;
    'GET /api/languages/user/locales': Op;
    'GET /api/languages/user/strings/{locale}': Op<{ locale: string | number }>;
    'DELETE /api/languages/{code}': Op<{ code: string | number }>;
    'POST /api/languages/{code}/ai-translate': Op<{ code: string | number }, UndeclaredQuery, {
        modelTier?: string;
    }>;
    'POST /api/languages/{code}/ai-translate-emails': Op<{ code: string | number }, UndeclaredQuery, {
        modelTier?: string;
    }>;
    'POST /api/languages/{code}/ai-translate-prompts': Op<{ code: string | number }, UndeclaredQuery, {
        modelTier?: string;
        promptIds?: Array<string>;
    }>;
    'PUT /api/languages/{code}/default': Op<{ code: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/languages/{code}/email-templates': Op<{ code: string | number }>;
    'PUT /api/languages/{code}/email-templates': Op<{ code: string | number }, UndeclaredQuery, {
        fields: {
            body?: string;
            ctaLabel?: string;
            intro?: string;
            subject?: string;
            title?: string;
        };
        templateId: 'verification' | 'welcome' | 'dsr_ack' | 'dsr_extension' | 'dsr_result' | 'project_collab';
    }>;
    'POST /api/languages/{code}/email-templates/{templateId}/preview': Op<{ code: string | number; templateId: string | number }, UndeclaredQuery, {
        fields?: {
            body?: string;
            ctaLabel?: string;
            intro?: string;
            subject?: string;
            title?: string;
        };
    }>;
    'POST /api/languages/{code}/email-templates/{templateId}/test': Op<{ code: string | number; templateId: string | number }, UndeclaredQuery, {
        testRecipient: string;
    }>;
    'GET /api/languages/{code}/export': Op<{ code: string | number }>;
    'GET /api/languages/{code}/gui': Op<{ code: string | number }>;
    'PUT /api/languages/{code}/gui': Op<{ code: string | number }, UndeclaredQuery, {
        translations: Record<string, string>;
    }>;
    'PATCH /api/languages/{code}/gui': Op<{ code: string | number }, UndeclaredQuery, {
        updates: Record<string, string | null>;
    }>;
    'POST /api/languages/{code}/import': Op<{ code: string | number }>;
    'GET /api/languages/{code}/prompts': Op<{ code: string | number }>;
    'GET /api/languages/{code}/prompts/{promptId}': Op<{ code: string | number; promptId: string | number }>;
    'PUT /api/languages/{code}/prompts/{promptId}': Op<{ code: string | number; promptId: string | number }, UndeclaredQuery, {
        text?: string | null;
    }>;
    'POST /api/license/activate': Op<NoParams, UndeclaredQuery, {
        scope?: 'organization' | 'consumer' | 'server';
        token: string;
    }>;
    'DELETE /api/license/deactivate': Op<NoParams, {
        scope?: 'server';
    }>;
    'GET /api/license/health': Op;
    'POST /api/license/refresh': Op<NoParams, UndeclaredQuery, Record<string, never>>;
    'GET /api/license/status': Op;
    'GET /api/maintenance': Op;
    'POST /api/maintenance/announce': Op<NoParams, UndeclaredQuery, {
        etaSeconds: number | string;
        reason?: string;
        ref?: string;
    }>;
    'POST /api/maintenance/clear': Op<NoParams, UndeclaredQuery, Record<string, never>>;
    'GET /api/mcp-library/me': Op;
    'PUT /api/mcp-library/me/{id}/credential': Op<{ id: string | number }, UndeclaredQuery, {
        value: string;
    }>;
    'DELETE /api/mcp-library/me/{id}/credential': Op<{ id: string | number }>;
    'GET /api/mcp-library/org': Op;
    'POST /api/mcp-library/org/probe': Op<NoParams, UndeclaredQuery, {
        auth?: {
            header?: string;
            style: 'none' | 'bearer' | 'header';
        };
        catalogId?: string;
        credential?: string;
        url?: string;
    }>;
    'PUT /api/mcp-library/org/server-wide/{serverId}': Op<{ serverId: string | number }, UndeclaredQuery, {
        access: {
            groupIds?: Array<string>;
            mode: 'everyone' | 'groups' | 'nobody';
        };
    }>;
    'POST /api/mcp-library/org/servers': Op<NoParams, UndeclaredQuery, {
        access?: {
            groupIds?: Array<string>;
            mode: 'everyone' | 'groups';
        };
        auth?: {
            header?: string;
            style: 'none' | 'bearer' | 'header';
        };
        catalogId?: string;
        credential?: string;
        credentialMode?: 'shared' | 'personal';
        description?: string;
        name?: string;
        tools?: Array<string>;
        url?: string;
    }>;
    'PATCH /api/mcp-library/org/servers/{id}': Op<{ id: string | number }, UndeclaredQuery, {
        access?: {
            groupIds?: Array<string>;
            mode: 'everyone' | 'groups';
        };
        credentialMode?: 'personal';
        enabled?: boolean;
        tools?: Array<string>;
    }>;
    'DELETE /api/mcp-library/org/servers/{id}': Op<{ id: string | number }>;
    'PUT /api/mcp-library/org/servers/{id}/credential': Op<{ id: string | number }, UndeclaredQuery, {
        value: string;
    }>;
    'POST /api/mcp-library/org/servers/{id}/refresh': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/mcp-library/policy': Op;
    'PUT /api/mcp-library/policy': Op<NoParams, UndeclaredQuery, {
        allowedHosts?: Array<string>;
        remote: 'off' | 'official' | 'allowlist' | 'any';
    }>;
    'GET /api/mcp-server/token': Op;
    'POST /api/mcp-server/token': Op<NoParams, UndeclaredQuery, Record<string, never>>;
    'DELETE /api/mcp-server/token': Op<NoParams, UndeclaredQuery, Record<string, never>>;
    'GET /api/mcp-tokens': Op;
    'POST /api/mcp-tokens': Op<NoParams, UndeclaredQuery, {
        expiresAt?: string | null;
        ipAllowlist?: Array<string>;
        name: string;
        scopes: Record<string, unknown>;
    }>;
    'PATCH /api/mcp-tokens/{id}': Op<{ id: string | number }, UndeclaredQuery, {
        enabled: boolean;
    }>;
    'DELETE /api/mcp-tokens/{id}': Op<{ id: string | number }>;
    'GET /api/me/notification-prefs': Op;
    'PUT /api/me/notification-prefs': Op<NoParams, UndeclaredQuery, {
        bell?: {
            added?: boolean;
            chat_mention?: boolean;
            comment_mention?: boolean;
            left?: boolean;
            owner_changed?: boolean;
            removed?: boolean;
            role_changed?: boolean;
            task_assigned?: boolean;
        };
        email?: {
            added?: boolean;
            chat_mention?: boolean;
            comment_mention?: boolean;
            left?: boolean;
            owner_changed?: boolean;
            removed?: boolean;
            role_changed?: boolean;
            task_assigned?: boolean;
        };
    }>;
    'GET /api/modules/frontend': Op;
    'GET /api/nc-scope': Op;
    'PUT /api/nc-scope': Op<NoParams, UndeclaredQuery, {
        integrations: {
            nextcloud?: {
                mode: 'all' | 'selected' | 'off';
                selected?: Array<string | number>;
            } | null;
            'nextcloud-activity'?: {
                mode: 'all' | 'selected' | 'off';
                selected?: Array<string | number>;
            } | null;
            'nextcloud-calendar'?: {
                mode: 'all' | 'selected' | 'off';
                selected?: Array<string | number>;
            } | null;
            'nextcloud-contacts'?: {
                mode: 'all' | 'selected' | 'off';
                selected?: Array<string | number>;
            } | null;
            'nextcloud-deck'?: {
                mode: 'all' | 'selected' | 'off';
                selected?: Array<string | number>;
            } | null;
            'nextcloud-forms'?: {
                mode: 'all' | 'selected' | 'off';
                selected?: Array<string | number>;
            } | null;
            'nextcloud-mail'?: {
                mode: 'all' | 'selected' | 'off';
                selected?: Array<string | number>;
            } | null;
            'nextcloud-notes'?: {
                mode: 'all' | 'selected' | 'off';
                selected?: Array<string | number>;
            } | null;
            'nextcloud-notifications'?: {
                mode: 'all' | 'selected' | 'off';
                selected?: Array<string | number>;
            } | null;
            'nextcloud-status'?: {
                mode: 'all' | 'selected' | 'off';
                selected?: Array<string | number>;
            } | null;
            'nextcloud-tables'?: {
                mode: 'all' | 'selected' | 'off';
                selected?: Array<string | number>;
            } | null;
            'nextcloud-talk'?: {
                mode: 'all' | 'selected' | 'off';
                selected?: Array<string | number>;
            } | null;
            'nextcloud-tasks'?: {
                mode: 'all' | 'selected' | 'off';
                selected?: Array<string | number>;
            } | null;
            'nextcloud-teams'?: {
                mode: 'all' | 'selected' | 'off';
                selected?: Array<string | number>;
            } | null;
        };
    }>;
    'POST /api/nc-scope/reset': Op<NoParams, UndeclaredQuery, Record<string, never>>;
    'GET /api/nc-scope/resources/{integrationId}': Op<{ integrationId: string | number }, {
        path?: string;
    }>;
    'POST /api/nc-scope/revoke-all': Op<NoParams, UndeclaredQuery, Record<string, never>>;
    'GET /api/nextcloud/studio-apps': Op;
    'POST /api/nextcloud/task-processing/execute': Op<NoParams, UndeclaredQuery, {
        appId?: string | null;
        customId?: string | null;
        input: Record<string, unknown>;
        ncUid?: string | null;
        taskType: string;
        [key: string]: unknown;
    }>;
    'GET /api/notebooks': Op<NoParams, {
        filter?: 'all' | 'pinned' | 'sources' | 'chat' | 'empty' | 'processing';
        limit?: number;
        offset?: number;
        search?: string;
        sort?: 'activity' | 'name' | 'created' | 'words';
    }>;
    'POST /api/notebooks': Op<NoParams, UndeclaredQuery, {
        description?: string | null;
        instructions?: string | null;
        name?: string;
    }>;
    'GET /api/notebooks/{id}': Op<{ id: string | number }>;
    'PUT /api/notebooks/{id}': Op<{ id: string | number }, UndeclaredQuery, {
        description?: string | null;
        documentContent?: string;
        expectedVersion?: number | null;
        instructions?: string | null;
        knowledgeBaseIds?: Array<string>;
        name?: string;
        pinned?: boolean;
        settings?: Record<string, unknown> | null;
    }>;
    'DELETE /api/notebooks/{id}': Op<{ id: string | number }>;
    'POST /api/notebooks/{id}/ai-fill': Op<{ id: string | number }, UndeclaredQuery, {
        documentContent: string;
        modelTier?: string;
    }>;
    'GET /api/notebooks/{id}/conversation': Op<{ id: string | number }>;
    'DELETE /api/notebooks/{id}/conversation': Op<{ id: string | number }>;
    'POST /api/notebooks/{id}/export/docx': Op<{ id: string | number }, UndeclaredQuery, {
        content: string;
        houseStyleId?: string;
        title?: string | null;
    }>;
    'POST /api/notebooks/{id}/export/nextcloud': Op<{ id: string | number }, UndeclaredQuery, {
        content: string;
        folder?: string | null;
        title?: string | null;
    }>;
    'POST /api/notebooks/{id}/export/pdf': Op<{ id: string | number }, UndeclaredQuery, {
        content: string;
        title?: string | null;
    }>;
    'POST /api/notebooks/{id}/export/signrequest': Op<{ id: string | number }, UndeclaredQuery, {
        content: string;
        message?: string;
        signers: Array<{
            email: string;
            first_name?: string;
            last_name?: string;
            order?: number;
        }>;
        subject?: string;
        title?: string | null;
    }>;
    'POST /api/notebooks/{id}/generate/{type}': Op<{ id: string | number; type: string | number }, UndeclaredQuery, {
        modelTier?: string;
    }>;
    'POST /api/notebooks/{id}/images': Op<{ id: string | number }>;
    'POST /api/notebooks/{id}/import-file': Op<{ id: string | number }>;
    'GET /api/notebooks/{id}/sources': Op<{ id: string | number }>;
    'POST /api/notebooks/{id}/sources/bulk-delete': Op<{ id: string | number }, UndeclaredQuery, {
        ids: Array<string>;
    }>;
    'POST /api/notebooks/{id}/sources/drive': Op<{ id: string | number }, UndeclaredQuery, {
        files: Array<{
            content?: string;
            driveFileId?: string;
            name?: string;
            [key: string]: unknown;
        }>;
        provider?: 'google' | 'microsoft';
    }>;
    'POST /api/notebooks/{id}/sources/file': Op<{ id: string | number }>;
    'POST /api/notebooks/{id}/sources/meeting': Op<{ id: string | number }, UndeclaredQuery, {
        meetingId: string;
        mode?: 'full' | 'summary';
    }>;
    'PATCH /api/notebooks/{id}/sources/reorder': Op<{ id: string | number }, UndeclaredQuery, {
        orderedIds: Array<string>;
    }>;
    'POST /api/notebooks/{id}/sources/text': Op<{ id: string | number }, UndeclaredQuery, {
        name?: string;
        text: string;
    }>;
    'POST /api/notebooks/{id}/sources/url': Op<{ id: string | number }, UndeclaredQuery, {
        url: string;
    }>;
    'PATCH /api/notebooks/{id}/sources/{sid}': Op<{ id: string | number; sid: string | number }, UndeclaredQuery, {
        name: string;
    }>;
    'DELETE /api/notebooks/{id}/sources/{sid}': Op<{ id: string | number; sid: string | number }>;
    'POST /api/notebooks/{id}/sources/{sid}/cancel': Op<{ id: string | number; sid: string | number }>;
    'GET /api/notebooks/{id}/sources/{sid}/content': Op<{ id: string | number; sid: string | number }>;
    'POST /api/notebooks/{id}/sources/{sid}/retry': Op<{ id: string | number; sid: string | number }>;
    'GET /api/notebooks/{id}/versions': Op<{ id: string | number }, {
        cursor?: string;
        limit?: number;
    }>;
    'POST /api/notebooks/{id}/versions': Op<{ id: string | number }, UndeclaredQuery, {
        name: string;
    }>;
    'POST /api/notebooks/{id}/versions/kept': Op<{ id: string | number }, UndeclaredQuery, {
        html: string;
    }>;
    'GET /api/notebooks/{id}/versions/{ref}': Op<{ id: string | number; ref: string | number }>;
    'DELETE /api/notebooks/{id}/versions/{ref}': Op<{ id: string | number; ref: string | number }>;
    'PUT /api/notebooks/{id}/versions/{ref}/name': Op<{ id: string | number; ref: string | number }, UndeclaredQuery, {
        name: string | null;
    }>;
    'POST /api/notebooks/{id}/versions/{ref}/restore': Op<{ id: string | number; ref: string | number }, UndeclaredQuery, {
        expectedVersion?: number | null;
    }>;
    'GET /api/notifications': Op<NoParams, {
        limit?: number;
        unread?: '0' | '1' | 'true' | 'false';
    }>;
    'POST /api/notifications/read-all': Op<NoParams, UndeclaredQuery, Record<string, never>>;
    'GET /api/notifications/unread-count': Op;
    'DELETE /api/notifications/{id}': Op<{ id: string | number }>;
    'POST /api/notifications/{id}/read': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/org-ai-context/{orgId}': Op<{ orgId: string | number }>;
    'PUT /api/org-ai-context/{orgId}': Op<{ orgId: string | number }, UndeclaredQuery, {
        compactionEnabled: boolean;
        compactionThreshold?: number;
        contextBudgetPercent?: number;
        recentWindow?: number;
    }>;
    'GET /api/org-azure-config/{orgId}': Op<{ orgId: string | number }>;
    'PUT /api/org-azure-config/{orgId}': Op<{ orgId: string | number }, UndeclaredQuery, {
        azureApiKey?: string;
        azureApiVersion?: string;
        azureEndpoint?: string;
        azureModels?: string;
        section: 'openai';
    } | {
        chatModelTiers: {
            fast?: {
                label?: string;
                modelId?: string;
                [key: string]: unknown;
            };
            pro?: {
                label?: string;
                modelId?: string;
                [key: string]: unknown;
            };
            smart?: {
                label?: string;
                modelId?: string;
                [key: string]: unknown;
            };
            standard?: {
                label?: string;
                modelId?: string;
                [key: string]: unknown;
            };
            swarm?: {
                label?: string;
                modelId?: string;
                [key: string]: unknown;
            };
            thinking?: {
                label?: string;
                modelId?: string;
                [key: string]: unknown;
            };
            writer?: {
                label?: string;
                modelId?: string;
                [key: string]: unknown;
            };
        };
        section: 'chatModels';
    } | {
        piiDetectionAction?: 'block' | 'tokenize' | 'warn';
        piiDetectionCategories?: Array<string> | null;
        piiDetectionConfidenceThreshold?: number;
        piiDetectionEnabled?: boolean;
        piiDetectionScope?: {
            agentOutput?: boolean;
            userInput?: boolean;
        };
        section: 'piiDetection';
    } | {
        azureDocIntelligenceEndpoint?: string;
        azureDocIntelligenceKey?: string;
        azureOpenaiEmbeddingEndpoint?: string;
        azureOpenaiEmbeddingKey?: string;
        azureOpenaiEmbeddingModel?: string;
        section: 'docProcessing';
        useAzureDocProcessing?: boolean;
    } | {
        autoApproveSSO?: boolean;
        section: 'sso';
        ssoClientId?: string;
        ssoClientSecret?: string;
        ssoTenantId?: string;
    }>;
    'POST /api/org-azure-config/{orgId}/sync-groups': Op<{ orgId: string | number }, UndeclaredQuery, Record<string, never>>;
    'PUT /api/org-azure-config/{orgId}/sync-groups/settings': Op<{ orgId: string | number }, UndeclaredQuery, {
        autoActivateUsers?: boolean;
        destructiveSync?: boolean;
        periodicSync?: boolean;
        syncIntervalHours?: number;
    }>;
    'GET /api/org-azure-config/{orgId}/sync-groups/status': Op<{ orgId: string | number }>;
    'GET /api/org-collab/{orgId}': Op<{ orgId: string | number }>;
    'PUT /api/org-collab/{orgId}': Op<{ orgId: string | number }, UndeclaredQuery, {
        collabEnabled: boolean;
    }>;
    'GET /api/org-integration-cache/{orgId}': Op<{ orgId: string | number }>;
    'PUT /api/org-integration-cache/{orgId}': Op<{ orgId: string | number }, UndeclaredQuery, {
        enabled: boolean;
        scopes?: {
            ai?: boolean;
            http?: boolean;
            integration?: boolean;
        };
        ttlSeconds?: number;
    }>;
    'DELETE /api/org-integration-cache/{orgId}/entries': Op<{ orgId: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/org-memory/{orgId}': Op<{ orgId: string | number }>;
    'PUT /api/org-memory/{orgId}': Op<{ orgId: string | number }, UndeclaredQuery, {
        enabled?: boolean;
        maxPerUser?: number;
        sensitiveOptInAllowed?: boolean;
    }>;
    'POST /api/org-memory/{orgId}/clear': Op<{ orgId: string | number }, UndeclaredQuery, {
        confirm: 'DELETE';
    }>;
    'GET /api/org-privacy-shield/user/guard-status': Op;
    'GET /api/org-privacy-shield/user/me': Op;
    'PUT /api/org-privacy-shield/user/me': Op<NoParams, UndeclaredQuery, {
        disableSearchOnUpload?: boolean;
        enabled: boolean;
        euModeEnabled?: boolean;
        piiDetectionAction?: 'block' | 'tokenize';
        piiDetectionCategories?: Array<string>;
        piiDetectionConfidenceThreshold?: number;
        piiDetectionEnabled?: boolean;
        piiFailureMode?: 'fail_closed' | 'fail_open';
        showRawPayload?: boolean;
        [key: string]: unknown;
    }>;
    'GET /api/org-privacy-shield/{orgId}': Op<{ orgId: string | number }>;
    'PUT /api/org-privacy-shield/{orgId}': Op<{ orgId: string | number }, UndeclaredQuery, {
        action?: 'delete' | 'redact';
        applyToAutomations?: boolean;
        attachmentLargeInputPolicy?: 'fail_open' | 'fail_closed';
        collectionIds?: Array<string>;
        customDataTests?: Record<string, unknown>;
        customDataTypes?: Array<unknown>;
        customSensitiveTerms?: Array<unknown>;
        disableSearchOnUpload?: boolean;
        dlpAllowlistedHosts?: Array<string>;
        dlpAlwaysReview?: boolean;
        dlpEnabled?: boolean;
        dlpFailureMode?: 'fail_closed' | 'fail_open';
        dlpMode?: 'ask' | 'auto_redact' | 'block';
        dlpScope?: 'external' | 'all';
        enabled: boolean;
        euModeEnabled?: boolean;
        monitorIntegrations?: boolean;
        piiAllowPublicOrgs?: boolean;
        piiAllowTerms?: Array<string | {
            term: string;
            [key: string]: unknown;
        }>;
        piiDetectionAction?: 'block' | 'tokenize' | 'warn';
        piiDetectionCategories?: Array<string>;
        piiDetectionConfidenceThreshold?: number;
        piiFailureMode?: 'fail_closed' | 'fail_open';
        privacy_scan_knowledge_bases?: boolean;
        scope?: {
            agentOutput?: boolean;
            userInput?: boolean;
            [key: string]: unknown;
        };
        showRawPayload?: boolean;
        toolPiiPolicy?: {
            external?: {
                blockCategories?: Array<string>;
            };
            internal?: {
                blockCategories?: Array<string>;
            };
        };
        webSearchGuardEnabled?: boolean;
        webSearchGuardPiiCategories?: Array<string>;
        [key: string]: unknown;
    }>;
    'POST /api/org-privacy-shield/{orgId}/custom-data/assist': Op<{ orgId: string | number }, UndeclaredQuery, {
        examples?: Array<string>;
        expectLookalikes: Array<string>;
        keepFixed?: Array<string>;
        type: {
            description?: string;
            id: string;
            method: 'words' | 'pattern' | 'ai';
            name: string;
            [key: string]: unknown;
        };
        [key: string]: unknown;
    }>;
    'POST /api/org-privacy-shield/{orgId}/custom-data/assist/preview': Op<{ orgId: string | number }, UndeclaredQuery, {
        examples?: Array<string>;
        keepFixed?: Array<string>;
        type: {
            description?: string;
            id: string;
            method: 'words' | 'pattern' | 'ai';
            name: string;
            [key: string]: unknown;
        };
        [key: string]: unknown;
    }>;
    'POST /api/org-privacy-shield/{orgId}/custom-data/test': Op<{ orgId: string | number }, UndeclaredQuery, {
        sentences: Array<{
            gold?: Array<{
                end: number;
                start: number;
                [key: string]: unknown;
            }> | null;
            id: string;
            origin?: 'assistant' | 'nearmiss' | 'own' | 'feedback';
            text: string;
            [key: string]: unknown;
        }>;
        type: {
            ai?: {
                floor: number;
                prompt: string;
                [key: string]: unknown;
            };
            createdAt?: string;
            createdBy?: string;
            description?: string;
            id: string;
            legacy?: boolean;
            method: 'words' | 'pattern' | 'ai';
            name?: string;
            origin?: 'created' | 'migrated';
            pattern?: {
                caseSensitive?: boolean;
                engine?: 're2' | 'v8-legacy';
                source: string;
                [key: string]: unknown;
            };
            tokenKey?: string;
            updatedAt?: string;
            words?: {
                caseSensitive?: boolean;
                values: Array<string>;
                wholeWord?: boolean;
                [key: string]: unknown;
            };
            [key: string]: unknown;
        };
        [key: string]: unknown;
    }>;
    'POST /api/org-privacy-shield/{orgId}/custom-data/tune': Op<{ orgId: string | number }, UndeclaredQuery, {
        candidates?: {
            aiLabels?: Array<string>;
            patterns?: Array<string>;
            [key: string]: unknown;
        };
        examples?: Array<string>;
        sentences?: Array<{
            gold?: Array<{
                end: number;
                start: number;
                [key: string]: unknown;
            }> | null;
            id: string;
            origin?: 'assistant' | 'nearmiss' | 'own' | 'feedback';
            text: string;
            [key: string]: unknown;
        }>;
        type: {
            ai?: {
                floor: number;
                prompt: string;
                [key: string]: unknown;
            };
            createdAt?: string;
            createdBy?: string;
            description?: string;
            id: string;
            legacy?: boolean;
            method: 'words' | 'pattern' | 'ai';
            name?: string;
            origin?: 'created' | 'migrated';
            pattern?: {
                caseSensitive?: boolean;
                engine?: 're2' | 'v8-legacy';
                source: string;
                [key: string]: unknown;
            };
            tokenKey?: string;
            updatedAt?: string;
            words?: {
                caseSensitive?: boolean;
                values: Array<string>;
                wholeWord?: boolean;
                [key: string]: unknown;
            };
            [key: string]: unknown;
        };
        [key: string]: unknown;
    }>;
    'GET /api/org-privacy-shield/{orgId}/effective': Op<{ orgId: string | number }>;
    'GET /api/org/mcp-access': Op<NoParams, {
        orgId?: string;
    }>;
    'PUT /api/org/mcp-access': Op<NoParams, UndeclaredQuery, {
        allowedUsers?: {
            mode?: 'all' | 'roles' | 'users';
            roles?: Array<string>;
            userIds?: Array<string>;
        };
        enabled?: boolean;
        ipAllowlist?: Array<string>;
        rejectLegacyTokens?: boolean;
    }>;
    'GET /api/organizations/{orgId}/custom-integrations': Op<{ orgId: string | number }>;
    'POST /api/organizations/{orgId}/custom-integrations': Op<{ orgId: string | number }, UndeclaredQuery, {
        description?: string | null;
        kind?: 'rest' | 'mcp_remote';
        name: string;
    }>;
    'GET /api/organizations/{orgId}/custom-integrations/{id}': Op<{ orgId: string | number; id: string | number }>;
    'DELETE /api/organizations/{orgId}/custom-integrations/{id}': Op<{ orgId: string | number; id: string | number }>;
    'POST /api/organizations/{orgId}/custom-integrations/{id}/activate': Op<{ orgId: string | number; id: string | number }, UndeclaredQuery, {
        allowWrites?: boolean;
        lendMode?: 'org' | 'byo';
    }>;
    'PUT /api/organizations/{orgId}/custom-integrations/{id}/credentials': Op<{ orgId: string | number; id: string | number }, UndeclaredQuery, {
        values: Record<string, unknown>;
    }>;
    'POST /api/organizations/{orgId}/custom-integrations/{id}/deactivate': Op<{ orgId: string | number; id: string | number }, UndeclaredQuery, Record<string, never>>;
    'PUT /api/organizations/{orgId}/custom-integrations/{id}/definition': Op<{ orgId: string | number; id: string | number }, UndeclaredQuery, {
        definition: Record<string, unknown>;
    }>;
    'POST /api/organizations/{orgId}/custom-integrations/{id}/refresh-tools': Op<{ orgId: string | number; id: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/organizations/{orgId}/custom-integrations/{id}/session': Op<{ orgId: string | number; id: string | number }>;
    'POST /api/organizations/{orgId}/custom-integrations/{id}/test-call': Op<{ orgId: string | number; id: string | number }, UndeclaredQuery, {
        args?: Record<string, unknown> | null;
        toolName: string;
    }>;
    'POST /api/organizations/{orgId}/custom-integrations/{id}/validate': Op<{ orgId: string | number; id: string | number }, UndeclaredQuery, {
        definition?: Record<string, unknown> | null;
        strict?: boolean;
    }>;
    'GET /api/playbooks': Op;
    'POST /api/playbooks': Op;
    'GET /api/playbooks/recipes': Op;
    'POST /api/playbooks/recipes/compose': Op;
    'GET /api/playbooks/{id}': Op<{ id: string | number }>;
    'PATCH /api/playbooks/{id}': Op<{ id: string | number }>;
    'DELETE /api/playbooks/{id}': Op<{ id: string | number }>;
    'POST /api/playbooks/{id}/phases/{key}/access-plan': Op<{ id: string | number; key: string | number }>;
    'POST /api/playbooks/{id}/phases/{key}/register': Op<{ id: string | number; key: string | number }>;
    'POST /api/playbooks/{id}/phases/{key}/resolve-plan': Op<{ id: string | number; key: string | number }>;
    'POST /api/playbooks/{id}/phases/{key}/retention-preview': Op<{ id: string | number; key: string | number }>;
    'POST /api/playbooks/{id}/phases/{key}/retry': Op<{ id: string | number; key: string | number }>;
    'POST /api/playbooks/{id}/phases/{key}/run': Op<{ id: string | number; key: string | number }>;
    'POST /api/playbooks/{id}/phases/{key}/skip': Op<{ id: string | number; key: string | number }>;
    'GET /api/privacy/chat-signals/preference': Op;
    'PUT /api/privacy/chat-signals/preference': Op<NoParams, UndeclaredQuery, {
        counted: boolean;
    }>;
    'GET /api/privacy/shield-status': Op;
    'GET /api/privacy/token-vault': Op<NoParams, {
        limit?: number;
        offset?: number;
        search?: string;
    }>;
    'DELETE /api/privacy/token-vault': Op<NoParams, UndeclaredQuery, Record<string, never>>;
    'DELETE /api/privacy/token-vault/{id}': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/projects': Op<NoParams, {
        includeArchived?: '0' | '1';
        kind?: 'workspace' | 'solution';
    }>;
    'POST /api/projects': Op<NoParams, UndeclaredQuery, {
        color?: string | null;
        customInstructions?: string | null;
        description?: string | null;
        extractMemories?: boolean | null;
        icon?: string | null;
        kind?: 'workspace' | 'solution';
        knowledgeBaseIds?: Array<string>;
        name: string;
    }>;
    'DELETE /api/projects/conversations/{convId}': Op<{ convId: string | number }, {
        type?: 'direct' | 'agent';
    }>;
    'GET /api/projects/package/blueprints': Op;
    'GET /api/projects/package/blueprints/{blueprintId}': Op<{ blueprintId: string | number }>;
    'DELETE /api/projects/package/blueprints/{blueprintId}': Op<{ blueprintId: string | number }>;
    'POST /api/projects/package/install': Op<NoParams, UndeclaredQuery, {
        blueprintId?: string;
        manifest?: Record<string, unknown>;
        name?: string;
        resolutions?: unknown;
    }>;
    'GET /api/projects/summary': Op<NoParams, {
        checks?: '0' | '1';
        ids?: string;
        since?: string;
    }>;
    'GET /api/projects/{id}': Op<{ id: string | number }>;
    'PUT /api/projects/{id}': Op<{ id: string | number }, UndeclaredQuery, {
        color?: string | null;
        customInstructions?: string | null;
        description?: string | null;
        editorsCanInvite?: boolean;
        extractMemories?: boolean | null;
        icon?: string | null;
        knowledgeBaseIds?: Array<string>;
        name?: string;
        version?: number | null;
    }>;
    'DELETE /api/projects/{id}': Op<{ id: string | number }>;
    'GET /api/projects/{id}/activity': Op<{ id: string | number }, {
        limit?: number;
        offset?: number;
    }>;
    'POST /api/projects/{id}/archive': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/projects/{id}/avatars/{userId}': Op<{ id: string | number; userId: string | number }>;
    'GET /api/projects/{id}/board': Op<{ id: string | number }>;
    'PUT /api/projects/{id}/board': Op<{ id: string | number }, UndeclaredQuery, {
        columns: Array<{
            id: string;
            status: 'todo' | 'doing' | 'done';
            title: string;
            wipLimit: number | null;
        }>;
        version: number;
    }>;
    'POST /api/projects/{id}/board/tasks': Op<{ id: string | number }, UndeclaredQuery, {
        columnId: string;
        title: string;
    }>;
    'PATCH /api/projects/{id}/board/tasks/{taskId}': Op<{ id: string | number; taskId: string | number }, UndeclaredQuery, {
        beforeId?: string | null;
        columnId: string;
    }>;
    'GET /api/projects/{id}/changes': Op<{ id: string | number }, {
        group?: 'item' | 'person';
        since?: string;
    }>;
    'GET /api/projects/{id}/changes/log': Op<{ id: string | number }, {
        limit?: number;
        offset?: number;
    }>;
    'GET /api/projects/{id}/chat-agents': Op<{ id: string | number }>;
    'GET /api/projects/{id}/chats': Op<{ id: string | number }, {
        archived?: '0' | '1';
    }>;
    'POST /api/projects/{id}/chats': Op<{ id: string | number }, UndeclaredQuery, {
        agentId?: string | null;
        aiMode?: 'off' | 'mention' | 'auto' | 'always';
        message?: string;
        refs?: Array<{
            id: string;
            kind: 'document' | 'notebook' | 'meeting' | 'task';
        }>;
        title?: string;
    }>;
    'GET /api/projects/{id}/chats/{chatId}': Op<{ id: string | number; chatId: string | number }>;
    'PATCH /api/projects/{id}/chats/{chatId}': Op<{ id: string | number; chatId: string | number }, UndeclaredQuery, {
        agentId?: string | null;
        aiMode?: 'off' | 'mention' | 'auto' | 'always';
        archived?: boolean;
        title?: string;
    }>;
    'DELETE /api/projects/{id}/chats/{chatId}': Op<{ id: string | number; chatId: string | number }>;
    'GET /api/projects/{id}/chats/{chatId}/messages': Op<{ id: string | number; chatId: string | number }, {
        after?: number;
        before?: number;
        limit?: number;
    }>;
    'POST /api/projects/{id}/chats/{chatId}/messages': Op<{ id: string | number; chatId: string | number }, UndeclaredQuery, {
        askAi?: boolean;
        clientMsgId?: string;
        content: string;
        mentions?: Array<string>;
        modelTier?: string | null;
        refs?: Array<{
            id: string;
            kind: 'document' | 'notebook' | 'meeting' | 'task';
        }>;
        replyTo?: string | null;
        threadId?: string | null;
    }>;
    'PATCH /api/projects/{id}/chats/{chatId}/messages/{messageId}': Op<{ id: string | number; chatId: string | number; messageId: string | number }, UndeclaredQuery, {
        content: string;
    }>;
    'DELETE /api/projects/{id}/chats/{chatId}/messages/{messageId}': Op<{ id: string | number; chatId: string | number; messageId: string | number }>;
    'POST /api/projects/{id}/chats/{chatId}/messages/{messageId}/feedback': Op<{ id: string | number; chatId: string | number; messageId: string | number }, UndeclaredQuery, {
        helpful: boolean;
    }>;
    'GET /api/projects/{id}/chats/{chatId}/messages/{messageId}/trace': Op<{ id: string | number; chatId: string | number; messageId: string | number }>;
    'POST /api/projects/{id}/chats/{chatId}/read': Op<{ id: string | number; chatId: string | number }, UndeclaredQuery, {
        seq: number;
    }>;
    'GET /api/projects/{id}/comments': Op<{ id: string | number }, {
        status?: 'open' | 'resolved' | 'all';
        targetId: string;
        targetType: 'notebook' | 'document' | 'task';
    }>;
    'POST /api/projects/{id}/comments': Op<{ id: string | number }, UndeclaredQuery, {
        aiMode?: 'off' | 'mention' | 'auto';
        anchor?: {
            blockIndex?: number;
            prefix?: string;
            quote: string;
            relEnd?: string;
            relStart?: string;
            sectionId?: string;
            suffix?: string;
        } | null;
        askAi?: boolean;
        clientThreadId?: string;
        content: string;
        mentions?: Array<string>;
        targetId: string;
        targetType: 'notebook' | 'document' | 'task';
    }>;
    'GET /api/projects/{id}/comments/{threadId}': Op<{ id: string | number; threadId: string | number }, {
        before?: number;
    }>;
    'PATCH /api/projects/{id}/comments/{threadId}': Op<{ id: string | number; threadId: string | number }, UndeclaredQuery, {
        aiMode: 'off' | 'mention' | 'auto';
    }>;
    'DELETE /api/projects/{id}/comments/{threadId}': Op<{ id: string | number; threadId: string | number }>;
    'POST /api/projects/{id}/comments/{threadId}/reopen': Op<{ id: string | number; threadId: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/projects/{id}/comments/{threadId}/replies': Op<{ id: string | number; threadId: string | number }, UndeclaredQuery, {
        askAi?: boolean;
        clientMsgId?: string;
        content: string;
        mentions?: Array<string>;
        replyTo?: string | null;
    }>;
    'PATCH /api/projects/{id}/comments/{threadId}/replies/{commentId}': Op<{ id: string | number; threadId: string | number; commentId: string | number }, UndeclaredQuery, {
        content: string;
        mentions?: Array<string>;
    }>;
    'DELETE /api/projects/{id}/comments/{threadId}/replies/{commentId}': Op<{ id: string | number; threadId: string | number; commentId: string | number }>;
    'POST /api/projects/{id}/comments/{threadId}/replies/{commentId}/feedback': Op<{ id: string | number; threadId: string | number; commentId: string | number }, UndeclaredQuery, {
        helpful: boolean;
    }>;
    'POST /api/projects/{id}/comments/{threadId}/resolve': Op<{ id: string | number; threadId: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/projects/{id}/completeness': Op<{ id: string | number }>;
    'GET /api/projects/{id}/compliance-hints': Op<{ id: string | number }>;
    'POST /api/projects/{id}/compliance-hints/{key}/dismiss': Op<{ id: string | number; key: 'project_foreign_members' | 'project_dangling_members' | 'project_orphaned_content' | 'project_files_unscanned' }, UndeclaredQuery, Record<string, never>>;
    'POST /api/projects/{id}/compliance-hints/{key}/snooze': Op<{ id: string | number; key: 'project_foreign_members' | 'project_dangling_members' | 'project_orphaned_content' | 'project_files_unscanned' }, UndeclaredQuery, {
        days?: 7 | 30;
    }>;
    'PUT /api/projects/{id}/conversations': Op<{ id: string | number }, UndeclaredQuery, {
        assign?: Array<{
            id: string;
            type?: 'direct' | 'agent';
        }>;
        unassign?: Array<{
            id: string;
            type?: 'direct' | 'agent';
        }>;
    }>;
    'GET /api/projects/{id}/deployments': Op<{ id: string | number }, {
        cursor?: string;
        limit?: number;
        stage?: 'uat' | 'prd';
    }>;
    'GET /api/projects/{id}/deployments/{depId}': Op<{ id: string | number; depId: string | number }>;
    'POST /api/projects/{id}/deployments/{depId}/cancel': Op<{ id: string | number; depId: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/projects/{id}/deployments/{depId}/retry': Op<{ id: string | number; depId: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/projects/{id}/docs': Op<{ id: string | number }, UndeclaredQuery, {
        kind: 'notebook' | 'document';
        resourceId: string;
    }>;
    'POST /api/projects/{id}/docs/{docId}/awareness': Op<{ id: string | number; docId: string | number }, UndeclaredQuery, {
        leave?: number;
        query?: boolean;
        update?: string;
    }>;
    'POST /api/projects/{id}/docs/{docId}/sync': Op<{ id: string | number; docId: string | number }, UndeclaredQuery, {
        sv: string;
    }>;
    'POST /api/projects/{id}/docs/{docId}/updates': Op<{ id: string | number; docId: string | number }, UndeclaredQuery, {
        awareness?: string;
        clientId: number;
        updates: Array<string>;
    }>;
    'POST /api/projects/{id}/documents': Op<{ id: string | number }, UndeclaredQuery, {
        docType?: string;
        locale?: string;
        name: string;
        starterId?: string;
        templateId?: string;
    }>;
    'GET /api/projects/{id}/files': Op<{ id: string | number }>;
    'POST /api/projects/{id}/files': Op<{ id: string | number }>;
    'DELETE /api/projects/{id}/files/{fileId}': Op<{ id: string | number; fileId: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/projects/{id}/files/{fileId}/content': Op<{ id: string | number; fileId: string | number }>;
    'GET /api/projects/{id}/graph': Op<{ id: string | number }>;
    'POST /api/projects/{id}/items/{type}/{itemId}/seen': Op<{ id: string | number; type: 'notebook' | 'document' | 'meeting'; itemId: string | number }, UndeclaredQuery, {
        versionId?: string | null;
    }>;
    'PUT /api/projects/{id}/kind': Op<{ id: string | number }, UndeclaredQuery, {
        kind: 'workspace' | 'solution';
    }>;
    'GET /api/projects/{id}/meetings/{meetingId}/task-suggestions': Op<{ id: string | number; meetingId: string | number }>;
    'POST /api/projects/{id}/meetings/{meetingId}/task-suggestions/improve': Op<{ id: string | number; meetingId: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/projects/{id}/members': Op<{ id: string | number }>;
    'PUT /api/projects/{id}/members/{memberId}': Op<{ id: string | number; memberId: string | number }, UndeclaredQuery, {
        role: 'viewer' | 'editor' | 'view' | 'edit';
    }>;
    'DELETE /api/projects/{id}/members/{memberId}': Op<{ id: string | number; memberId: string | number }>;
    'PUT /api/projects/{id}/members/{userId}/color': Op<{ id: string | number; userId: string | number }, UndeclaredQuery, {
        color: string | null;
    }>;
    'PUT /api/projects/{id}/mute': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'DELETE /api/projects/{id}/mute': Op<{ id: string | number }>;
    'GET /api/projects/{id}/my-chats': Op<{ id: string | number }, {
        limit?: number;
    }>;
    'POST /api/projects/{id}/notebooks': Op<{ id: string | number }, UndeclaredQuery, {
        description?: string;
        name: string;
    }>;
    'POST /api/projects/{id}/package/export': Op<{ id: string | number }, UndeclaredQuery, {
        save?: boolean;
    }>;
    'GET /api/projects/{id}/package/installs': Op<{ id: string | number }>;
    'GET /api/projects/{id}/package/releases': Op<{ id: string | number }>;
    'GET /api/projects/{id}/package/releases/{releaseId}': Op<{ id: string | number; releaseId: string | number }, {
        download?: '0' | '1';
    }>;
    'POST /api/projects/{id}/package/upgrade': Op<{ id: string | number }, UndeclaredQuery, {
        blueprintId?: string;
        manifest?: Record<string, unknown>;
    }>;
    'POST /api/projects/{id}/package/upgrade/plan': Op<{ id: string | number }, UndeclaredQuery, {
        blueprintId?: string;
        manifest?: Record<string, unknown>;
    }>;
    'PATCH /api/projects/{id}/parts/{ref}/options': Op<{ id: string | number; ref: string | number }, UndeclaredQuery, {
        acks?: Array<string | {
            contentHash?: string;
            docRef: string;
        }>;
        contentMode?: 'shell' | 'carry';
        reference?: boolean;
    }>;
    'GET /api/projects/{id}/pins': Op<{ id: string | number }>;
    'PUT /api/projects/{id}/pins': Op<{ id: string | number }, UndeclaredQuery, {
        id: string;
        type: 'chat' | 'task' | 'document' | 'notebook' | 'meeting' | 'file';
    }>;
    'DELETE /api/projects/{id}/pins/{type}/{itemId}': Op<{ id: string | number; type: 'chat' | 'task' | 'document' | 'notebook' | 'meeting' | 'file'; itemId: string | number }>;
    'GET /api/projects/{id}/pipeline': Op<{ id: string | number }>;
    'POST /api/projects/{id}/presence': Op<{ id: string | number }, UndeclaredQuery, {
        target?: {
            id: string;
            type: 'document' | 'notebook' | 'meeting' | 'task' | 'chat';
        };
    }>;
    'GET /api/projects/{id}/principals': Op<{ id: string | number }, {
        q?: string;
    }>;
    'POST /api/projects/{id}/release-and-deploy': Op<{ id: string | number }, UndeclaredQuery, {
        acknowledgements?: Array<{
            code: string;
            docRef?: string | null;
            ref?: string | null;
        }>;
        notes?: string;
        requestKey: string;
    }>;
    'GET /api/projects/{id}/releases': Op<{ id: string | number }>;
    'POST /api/projects/{id}/releases': Op<{ id: string | number }, UndeclaredQuery, {
        notes?: string;
        requestKey?: string;
    }>;
    'GET /api/projects/{id}/releases/{releaseId}': Op<{ id: string | number; releaseId: string | number }>;
    'GET /api/projects/{id}/resources': Op<{ id: string | number }>;
    'PUT /api/projects/{id}/resources': Op<{ id: string | number }, UndeclaredQuery, {
        attach?: boolean;
        id?: string;
        kind?: string;
    }>;
    'POST /api/projects/{id}/resources/related': Op<{ id: string | number }, UndeclaredQuery, {
        items: Array<{
            id: string;
            kind: string;
        }>;
    }>;
    'POST /api/projects/{id}/restore': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/projects/{id}/search': Op<{ id: string | number }, {
        cursor?: number;
        q?: string;
        type?: 'chat' | 'task' | 'document' | 'notebook' | 'meeting' | 'file';
    }>;
    'POST /api/projects/{id}/seen': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/projects/{id}/share': Op<{ id: string | number }, UndeclaredQuery, {
        permission?: 'viewer' | 'editor' | 'view' | 'edit';
        sharedWithId: string;
        sharedWithType: 'user' | 'group';
    }>;
    'DELETE /api/projects/{id}/share/{shareId}': Op<{ id: string | number; shareId: string | number }>;
    'GET /api/projects/{id}/sprints': Op<{ id: string | number }>;
    'POST /api/projects/{id}/sprints': Op<{ id: string | number }, UndeclaredQuery, {
        capacityPoints?: number | null;
        endDate?: string | null;
        goal?: string;
        name: string;
        startDate?: string | null;
    }>;
    'PATCH /api/projects/{id}/sprints/{sprintId}': Op<{ id: string | number; sprintId: string | number }, UndeclaredQuery, {
        capacityPoints?: number | null;
        endDate?: string | null;
        goal?: string;
        name?: string;
        startDate?: string | null;
    }>;
    'DELETE /api/projects/{id}/sprints/{sprintId}': Op<{ id: string | number; sprintId: string | number }>;
    'POST /api/projects/{id}/sprints/{sprintId}/complete': Op<{ id: string | number; sprintId: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/projects/{id}/sprints/{sprintId}/items': Op<{ id: string | number; sprintId: string | number }, UndeclaredQuery, {
        taskIds: Array<string>;
    }>;
    'DELETE /api/projects/{id}/sprints/{sprintId}/items/{taskId}': Op<{ id: string | number; sprintId: string | number; taskId: string | number }>;
    'POST /api/projects/{id}/sprints/{sprintId}/start': Op<{ id: string | number; sprintId: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/projects/{id}/stages': Op<{ id: string | number }, UndeclaredQuery, {
        requestKey?: string;
        stages: Array<'uat' | 'prd'>;
    }>;
    'GET /api/projects/{id}/stages/{stage}': Op<{ id: string | number; stage: string | number }>;
    'PATCH /api/projects/{id}/stages/{stage}': Op<{ id: string | number; stage: string | number }, UndeclaredQuery, {
        approvalPolicy?: Record<string, unknown> | null;
        enabled?: boolean;
        newPartsActive?: boolean;
        requiresApproval?: boolean;
        rollbackNeedsApproval?: boolean;
        settingsVersion: number;
    }>;
    'DELETE /api/projects/{id}/stages/{stage}': Op<{ id: string | number; stage: string | number }, UndeclaredQuery, {
        confirm: string;
        deleteData?: boolean;
        mode: 'detach' | 'delete';
        requestKey?: string;
    }>;
    'PUT /api/projects/{id}/stages/{stage}/bindings': Op<{ id: string | number; stage: string | number }, UndeclaredQuery, {
        bindings: Array<{
            slot: string;
            value: unknown;
        }>;
        settingsVersion: number;
    }>;
    'POST /api/projects/{id}/stages/{stage}/deployments': Op<{ id: string | number; stage: string | number }, UndeclaredQuery, {
        acknowledgements?: Array<{
            code: string;
            docRef?: string | null;
            ref?: string | null;
        }>;
        kind?: 'deploy' | 'rollback' | 'redeploy';
        note?: string;
        planHash: string;
        releaseId?: string | null;
        requestKey: string;
    }>;
    'PATCH /api/projects/{id}/stages/{stage}/parts/{ref}': Op<{ id: string | number; stage: string | number; ref: string | number }, UndeclaredQuery, {
        active?: boolean;
        audience?: {
            published: boolean;
            sharedGroups?: Array<string>;
        };
    }>;
    'POST /api/projects/{id}/stages/{stage}/pause': Op<{ id: string | number; stage: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/projects/{id}/stages/{stage}/plan': Op<{ id: string | number; stage: string | number }, UndeclaredQuery, {
        kind?: 'deploy' | 'rollback' | 'redeploy';
        releaseId?: string | null;
    }>;
    'GET /api/projects/{id}/stages/{stage}/requirements': Op<{ id: string | number; stage: string | number }, {
        releaseId?: string;
    }>;
    'POST /api/projects/{id}/stages/{stage}/resume': Op<{ id: string | number; stage: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/projects/{id}/stages/{stage}/variables': Op<{ id: string | number; stage: string | number }>;
    'PUT /api/projects/{id}/stages/{stage}/variables': Op<{ id: string | number; stage: string | number }, UndeclaredQuery, {
        values: Record<string, string | number | boolean | null>;
    }>;
    'GET /api/projects/{id}/stream': Op<{ id: string | number }, {
        doc?: string;
        docSince?: number;
        since?: number;
    }>;
    'GET /api/projects/{id}/tasks': Op<{ id: string | number }>;
    'POST /api/projects/{id}/tasks': Op<{ id: string | number }, UndeclaredQuery, {
        assigneeIds?: Array<string>;
        checklist?: Array<{
            done: boolean;
            id: string;
            text: string;
        }>;
        description?: string;
        dueDate?: string | null;
        itemType?: 'epic' | 'story' | 'user-story' | 'task';
        labels?: Array<string>;
        links?: Array<{
            chatId?: string;
            id: string;
            kind: 'document' | 'notebook' | 'meeting' | 'chat' | 'thread' | 'task';
            relation?: 'depends_on';
        }>;
        parentTaskId?: string | null;
        priority?: 'low' | 'normal' | 'high' | 'urgent';
        source?: {
            id: string;
            itemId: string;
            kind: 'meeting';
        };
        startDate?: string | null;
        status?: 'todo' | 'doing' | 'done';
        storyPoints?: number | null;
        title: string;
    }>;
    'POST /api/projects/{id}/tasks/batch': Op<{ id: string | number }, UndeclaredQuery, {
        items: Array<{
            assigneeIds?: Array<string>;
            checklist?: Array<{
                done: boolean;
                id: string;
                text: string;
            }>;
            description?: string;
            dueDate?: string | null;
            itemType?: 'epic' | 'story' | 'user-story' | 'task';
            labels?: Array<string>;
            links?: Array<{
                chatId?: string;
                id: string;
                kind: 'document' | 'notebook' | 'meeting' | 'chat' | 'thread' | 'task';
                relation?: 'depends_on';
            }>;
            parentTaskId?: string | null;
            priority?: 'low' | 'normal' | 'high' | 'urgent';
            source?: {
                id: string;
                itemId: string;
                kind: 'meeting';
            };
            startDate?: string | null;
            status?: 'todo' | 'doing' | 'done';
            storyPoints?: number | null;
            title: string;
        }>;
    }>;
    'GET /api/projects/{id}/tasks/poker/session': Op<{ id: string | number }>;
    'POST /api/projects/{id}/tasks/poker/session/cancel': Op<{ id: string | number }, UndeclaredQuery, {
        sessionId: string;
    }>;
    'POST /api/projects/{id}/tasks/poker/session/finish': Op<{ id: string | number }, UndeclaredQuery, {
        sessionId: string;
        storyPoints: number;
    }>;
    'POST /api/projects/{id}/tasks/poker/session/next': Op<{ id: string | number }, UndeclaredQuery, {
        sessionId: string;
        storyPoints: number;
    }>;
    'POST /api/projects/{id}/tasks/poker/session/reveal': Op<{ id: string | number }, UndeclaredQuery, {
        sessionId: string;
    }>;
    'POST /api/projects/{id}/tasks/poker/session/start': Op<{ id: string | number }, UndeclaredQuery, {
        taskId?: string;
        taskIds?: Array<string>;
    }>;
    'POST /api/projects/{id}/tasks/poker/session/vote': Op<{ id: string | number }, UndeclaredQuery, {
        sessionId: string;
        vote: '1' | '2' | '3' | '5' | '8' | '13' | '21' | '?';
    }>;
    'PATCH /api/projects/{id}/tasks/{taskId}': Op<{ id: string | number; taskId: string | number }, UndeclaredQuery, {
        assigneeIds?: Array<string>;
        beforeId?: string | null;
        checklist?: Array<{
            done: boolean;
            id: string;
            text: string;
        }>;
        description?: string;
        dueDate?: string | null;
        itemType?: 'epic' | 'story' | 'user-story' | 'task';
        labels?: Array<string>;
        links?: Array<{
            chatId?: string;
            id: string;
            kind: 'document' | 'notebook' | 'meeting' | 'chat' | 'thread' | 'task';
            relation?: 'depends_on';
        }>;
        parentTaskId?: string | null;
        priority?: 'low' | 'normal' | 'high' | 'urgent';
        startDate?: string | null;
        status?: 'todo' | 'doing' | 'done';
        storyPoints?: number | null;
        title?: string;
    }>;
    'DELETE /api/projects/{id}/tasks/{taskId}': Op<{ id: string | number; taskId: string | number }>;
    'POST /api/projects/{id}/tasks/{taskId}/improve': Op<{ id: string | number; taskId: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/projects/{id}/threads': Op<{ id: string | number }, {
        limit?: number;
        offset?: number;
    }>;
    'POST /api/projects/{id}/threads': Op<{ id: string | number }, UndeclaredQuery, {
        conversationId: string;
        type?: 'direct' | 'agent';
    }>;
    'DELETE /api/projects/{id}/threads/{convId}': Op<{ id: string | number; convId: string | number }, {
        type?: 'direct' | 'agent';
    }>;
    'POST /api/projects/{id}/transfer-owner': Op<{ id: string | number }, UndeclaredQuery, {
        expectedOwnerId?: string;
        keepMeAs?: 'editor' | 'viewer' | 'none';
        toUserId: string;
    }>;
    'POST /api/projects/{id}/typing': Op<{ id: string | number }, UndeclaredQuery, {
        conversationId?: string | null;
    }>;
    'GET /api/projects/{id}/variables': Op<{ id: string | number }>;
    'PUT /api/projects/{id}/variables': Op<{ id: string | number }, UndeclaredQuery, {
        variables: Array<{
            choices?: Array<string> | null;
            description?: string;
            name: string;
            required?: boolean;
            steering?: boolean;
            type?: 'text' | 'number' | 'boolean' | 'url' | 'email' | 'choice';
        }>;
    }>;
    'POST /api/projects/{id}/visit': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/public-app/{token}': Op<{ token: string | number }>;
    'POST /api/public-app/{token}/actions/{actionId}/step': Op<{ token: string | number; actionId: string | number }, UndeclaredQuery, {
        actionResults?: Record<string, unknown> | null;
        callPath?: Array<number>;
        error?: {
            attempts: number;
            code?: string | null;
            message: string;
            step: string;
            stepIndex?: number;
            [key: string]: unknown;
        };
        formValues?: Record<string, unknown> | null;
        forms?: Record<string, unknown> | null;
        index?: number | null;
        item?: unknown;
        kind?: string;
        params?: Record<string, unknown> | null;
        runKey?: string;
        screenParams?: Record<string, unknown> | null;
        stepIndex: number;
        value?: unknown;
        vars?: Record<string, unknown> | null;
    }>;
    'GET /api/public-app/{token}/assets/{assetId}': Op<{ token: string | number; assetId: string | number }>;
    'POST /api/public-app/{token}/data/attachments': Op<{ token: string | number }, UndeclaredQuery, {
        fieldKey?: string;
    }>;
    'GET /api/public-app/{token}/data/attachments/{fileId}': Op<{ token: string | number; fileId: string | number }>;
    'DELETE /api/public-app/{token}/data/attachments/{fileId}': Op<{ token: string | number; fileId: string | number }>;
    'POST /api/public-app/{token}/data/batch': Op<{ token: string | number }, UndeclaredQuery, {
        reads?: unknown;
    }>;
    'POST /api/public-app/{token}/data/query': Op<{ token: string | number }>;
    'GET /api/public-app/{token}/data/tables/{tableId}/records': Op<{ token: string | number; tableId: string | number }, {
        cursor?: string;
        expand?: string;
        fields?: string;
        filter?: string;
        limit?: number;
        match?: 'all' | 'any';
        orderBy?: string;
        sample?: '0' | '1';
        search?: string;
        sort?: string;
        total?: '0' | '1';
    }>;
    'POST /api/public-share/ai/chat': Op;
    'POST /api/public-share/ai/stream': Op;
    'GET /api/public/github-stats': Op;
    'GET /api/release-notes/admin': Op;
    'PUT /api/release-notes/admin/{id}': Op<{ id: string | number }, UndeclaredQuery, {
        items?: Array<{
            body?: string;
            kind: 'feature' | 'improvement' | 'fix';
            title?: string;
        }>;
        lead?: string;
        title?: string;
        version?: string;
    }>;
    'DELETE /api/release-notes/admin/{id}': Op<{ id: string | number }>;
    'POST /api/release-notes/admin/{id}/publish': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/release-notes/admin/{id}/unpublish': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/release-notes/ingest': Op<NoParams, UndeclaredQuery, {
        channel?: 'dev' | 'prod';
        commitSubjects?: string | Array<string> | null;
        diffstat?: string | null;
        entry?: Record<string, unknown> | null;
        fromSha?: string | null;
        prTitles?: string | Array<string> | null;
        services?: string | null;
        toSha?: string | null;
        version?: string | null;
    }>;
    'GET /api/release-notes/public': Op;
    'GET /api/reminders': Op<NoParams, {
        completed?: '0' | '1' | 'true' | 'false';
    }>;
    'POST /api/reminders': Op<NoParams, UndeclaredQuery, {
        message?: string | null;
        remindAt: string;
        repeatInterval?: 'daily' | 'weekly' | 'monthly' | null;
        title: string;
    }>;
    'PUT /api/reminders/{id}': Op<{ id: string | number }, UndeclaredQuery, {
        message?: string | null;
        remindAt?: string;
        repeatInterval?: 'daily' | 'weekly' | 'monthly' | null;
        title?: string;
    }>;
    'DELETE /api/reminders/{id}': Op<{ id: string | number }>;
    'POST /api/reminders/{id}/complete': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/search/embed': Op<NoParams, UndeclaredQuery, {
        kind?: 'query' | 'passage';
        texts: Array<string>;
    }>;
    'GET /api/search/health': Op;
    'DELETE /api/search/kb/documents/{documentId}': Op<{ documentId: string | number }, {
        knowledge_base_id?: string;
        tenant_id?: string;
    }, {
        knowledge_base_id?: string;
        tenant_id?: string;
    }>;
    'POST /api/search/kb/ingest/json': Op<NoParams, UndeclaredQuery, {
        azure_endpoint?: unknown;
        azure_key?: unknown;
        azure_model?: unknown;
        content: string;
        document_id: string;
        knowledge_base_id: string;
        lang?: string | null;
        source_uri?: string | null;
        tenant_id: string;
        title?: string | null;
        use_azure?: unknown;
    }>;
    'GET /api/search/kb/{kbId}/documents/{documentId}/content': Op<{ kbId: string | number; documentId: string | number }, {
        tenant_id?: string;
    }>;
    'POST /api/search/rerank': Op<NoParams, UndeclaredQuery, {
        documents: Array<string>;
        query: string;
        top_n?: number | null;
    }>;
    'POST /api/search/tools/kb-search': Op<NoParams, UndeclaredQuery, {
        azure_endpoint?: unknown;
        azure_key?: unknown;
        azure_model?: unknown;
        inference_routing?: unknown;
        kb_ids: Array<string>;
        query: string;
        rerank?: unknown;
        tenant_id: string;
        top_k?: number | null;
        use_azure?: unknown;
    }>;
    'POST /api/search/tools/search': Op<NoParams, UndeclaredQuery, {
        kb?: {
            kb_ids?: Array<string>;
            tenant_id?: string;
            top_k_final?: number;
            top_k_fts?: unknown;
            top_k_vector?: unknown;
            use_reranker?: unknown;
        };
        kb_ids?: Array<string>;
        kb_scope?: {
            knowledge_base_ids?: Array<string>;
            tenant_id: string;
        } | null;
        mode?: 'web' | 'web_fast' | 'kb' | 'auto';
        query: string;
        response?: unknown;
        tenant_id?: string;
        web?: {
            allow_js_fallback?: unknown;
            fetch_top_n?: unknown;
            max_results?: number;
        };
    }>;
    'GET /api/session-token': Op;
    'GET /api/skills': Op;
    'POST /api/skills': Op<NoParams, UndeclaredQuery, {
        allowedAutomationIds?: unknown;
        automationId?: string | null;
        description?: string;
        dynamicActivation?: boolean;
        enabledIntegrations?: Array<string> | null;
        examples?: string;
        examplesV2?: unknown;
        icon?: string;
        instructions?: string;
        isShared?: boolean;
        knowledgeBaseIds?: unknown;
        name: string;
        outputSchema?: unknown;
        rules?: string;
        rulesV2?: unknown;
        sharedGroups?: Array<string> | null;
        steps?: unknown;
        workflow?: string;
    }>;
    'POST /api/skills/ai/draft': Op<NoParams, UndeclaredQuery, {
        sentence?: string;
    }>;
    'GET /api/skills/examples/conversations': Op;
    'GET /api/skills/examples/conversations/{conversationId}/messages': Op<{ conversationId: string | number }>;
    'GET /api/skills/test-agents': Op;
    'GET /api/skills/usage-summary': Op;
    'GET /api/skills/{id}': Op<{ id: string | number }>;
    'PUT /api/skills/{id}': Op<{ id: string | number }, UndeclaredQuery, {
        allowedAutomationIds?: unknown;
        automationId?: string | null;
        description?: string;
        dynamicActivation?: boolean;
        enabledIntegrations?: Array<string> | null;
        examples?: string;
        examplesV2?: unknown;
        icon?: string;
        instructions?: string;
        isShared?: boolean;
        knowledgeBaseIds?: unknown;
        name?: string;
        outputSchema?: unknown;
        rules?: string;
        rulesV2?: unknown;
        sharedGroups?: Array<string> | null;
        steps?: unknown;
        workflow?: string;
    }>;
    'DELETE /api/skills/{id}': Op<{ id: string | number }, {
        confirmBreaking?: 'true' | 'false';
    }, {
        confirmBreaking?: boolean;
    }>;
    'POST /api/skills/{id}/ai/improve': Op<{ id: string | number }, UndeclaredQuery, {
        note?: string;
    }>;
    'POST /api/skills/{id}/examples/from-message': Op<{ id: string | number }, UndeclaredQuery, {
        conversationId: string;
        messageIndex: number;
        question?: string;
    }>;
    'POST /api/skills/{id}/test': Op<{ id: string | number }, UndeclaredQuery, {
        agentId?: string | null;
        question?: string;
    }>;
    'GET /api/skills/{id}/test-runs': Op<{ id: string | number }>;
    'GET /api/skills/{id}/usage': Op<{ id: string | number }>;
    'GET /api/solution-stages/{stageProjectId}': Op<{ stageProjectId: string | number }>;
    'POST /api/solution-stages/{stageProjectId}/detach': Op<{ stageProjectId: string | number }, UndeclaredQuery, {
        confirm: string;
    }>;
    'PATCH /api/solution-stages/{stageProjectId}/parts/{ref}': Op<{ stageProjectId: string | number; ref: string | number }, UndeclaredQuery, {
        active: boolean;
    }>;
    'POST /api/solution-stages/{stageProjectId}/pause': Op<{ stageProjectId: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/solution-stages/{stageProjectId}/resume': Op<{ stageProjectId: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/solution-stages/{stageProjectId}/variables': Op<{ stageProjectId: string | number }>;
    'PUT /api/solution-stages/{stageProjectId}/variables': Op<{ stageProjectId: string | number }, UndeclaredQuery, {
        values: Record<string, string | number | boolean | null>;
    }>;
    'GET /api/step': Op;
    'POST /api/step': Op<NoParams, UndeclaredQuery, {
        category?: string | null;
        definition?: Record<string, unknown>;
        description?: string | null;
        icon?: string | null;
        title: string;
    }>;
    'GET /api/step/chat-tools': Op;
    'GET /api/step/{id}': Op<{ id: string | number }>;
    'PUT /api/step/{id}': Op<{ id: string | number }, UndeclaredQuery, {
        category?: string | null;
        definition?: Record<string, unknown>;
        description?: string | null;
        icon?: string | null;
        title?: string;
    }>;
    'DELETE /api/step/{id}': Op<{ id: string | number }>;
    'PUT /api/step/{id}/expose': Op<{ id: string | number }, UndeclaredQuery, {
        exposeAsTool: boolean;
    }>;
    'POST /api/step/{id}/publish': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'PUT /api/step/{id}/sharing': Op<{ id: string | number }, UndeclaredQuery, {
        isPublished: boolean;
        sharedGroups?: Array<string>;
    }>;
    'POST /api/step/{id}/test': Op<{ id: string | number }, UndeclaredQuery, {
        inputs?: Record<string, unknown> | null;
    }>;
    'GET /api/step/{id}/versions': Op<{ id: string | number }>;
    'GET /api/storage/file/{fileKey}': Op<{ fileKey: string | number }>;
    'GET /api/storage/tmp/{token}': Op<{ token: string | number }>;
    'POST /api/stripe/checkout': Op<NoParams, UndeclaredQuery, {
        origin?: string;
        planId: string;
        successUrl?: string;
        withdrawalWaiver?: {
            accepted?: boolean;
        };
    }>;
    'GET /api/stripe/invoices': Op;
    'GET /api/stripe/invoices/{id}/pdf': Op<{ id: string | number }>;
    'GET /api/stripe/plans': Op<NoParams, {
        type?: 'organization' | 'consumer';
    }>;
    'POST /api/stripe/portal': Op<NoParams, UndeclaredQuery, {
        origin?: string;
    }>;
    'GET /api/stripe/promo-codes': Op<NoParams, {
        limit?: number;
    }>;
    'POST /api/stripe/promo-codes': Op<NoParams, UndeclaredQuery, {
        code: string;
        currency?: string;
        discountType: 'percent' | 'fixed';
        discountValue: number;
        duration?: 'once' | 'repeating' | 'forever';
        durationMonths?: number;
        expiresAt?: string;
        firstTimeOnly?: boolean;
        maxRedemptions?: number;
        minAmount?: number;
        name?: string;
    }>;
    'PUT /api/stripe/promo-codes/{id}/activate': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'PUT /api/stripe/promo-codes/{id}/deactivate': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/stripe/sessions/{id}': Op<{ id: string | number }>;
    'GET /api/stripe/status': Op;
    'POST /api/stripe/webhook': Op;
    'GET /api/studio-apps': Op;
    'POST /api/studio-apps': Op<NoParams, UndeclaredQuery, {
        accentColor?: string | null;
        description?: string | null;
        icon?: string | null;
        name?: string | null;
        templateId?: string | null;
    }>;
    'GET /api/studio-apps/builder/session/{appId}': Op<{ appId: string | number }>;
    'POST /api/studio-apps/builder/stream': Op;
    'GET /api/studio-apps/catalog': Op;
    'POST /api/studio-apps/import': Op;
    'GET /api/studio-apps/mine': Op;
    'GET /api/studio-apps/templates': Op;
    'POST /api/studio-apps/templates/import': Op;
    'GET /api/studio-apps/templates/{templateId}': Op<{ templateId: string | number }>;
    'DELETE /api/studio-apps/templates/{templateId}': Op<{ templateId: string | number }>;
    'GET /api/studio-apps/templates/{templateId}/export': Op<{ templateId: string | number }, {
        download?: '0' | '1';
    }>;
    'GET /api/studio-apps/usage': Op;
    'GET /api/studio-apps/usage-counts': Op<NoParams, {
        window?: string;
    }>;
    'GET /api/studio-apps/{id}': Op<{ id: string | number }>;
    'PUT /api/studio-apps/{id}': Op<{ id: string | number }, UndeclaredQuery, {
        accentColor?: string | null;
        category?: string | null;
        description?: string | null;
        icon?: string | null;
        name?: string;
    }>;
    'DELETE /api/studio-apps/{id}': Op<{ id: string | number }>;
    'GET /api/studio-apps/{id}/actions/jobs': Op<{ id: string | number }, {
        actionId?: string;
        active?: '0' | '1';
        draft?: '0' | '1' | 'true' | 'false';
    }>;
    'GET /api/studio-apps/{id}/actions/jobs/{jobId}': Op<{ id: string | number; jobId: string | number }>;
    'POST /api/studio-apps/{id}/actions/jobs/{jobId}/cancel': Op<{ id: string | number; jobId: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/studio-apps/{id}/actions/jobs/{jobId}/resume': Op<{ id: string | number; jobId: string | number }, UndeclaredQuery, {
        payload?: unknown;
        token: string;
    }>;
    'GET /api/studio-apps/{id}/actions/runs/{runId}': Op<{ id: string | number; runId: string | number }>;
    'POST /api/studio-apps/{id}/actions/{actionId}/background': Op<{ id: string | number; actionId: string | number }, {
        draft?: '0' | '1' | 'true' | 'false';
    }, {
        formValues?: Record<string, unknown> | null;
        index?: number | null;
        item?: unknown;
        value?: unknown;
        vars?: Record<string, unknown> | null;
    }>;
    'POST /api/studio-apps/{id}/actions/{actionId}/run': Op<{ id: string | number; actionId: string | number }, {
        draft?: '0' | '1' | 'true' | 'false';
    }, {
        formValues?: Record<string, unknown> | null;
        wait?: boolean;
    }>;
    'POST /api/studio-apps/{id}/actions/{actionId}/runs/end': Op<{ id: string | number; actionId: string | number }, {
        draft?: '0' | '1' | 'true' | 'false';
    }, {
        error?: string;
        handled?: boolean;
        runKey?: string;
        status?: 'success' | 'error' | 'cancelled';
    }>;
    'POST /api/studio-apps/{id}/actions/{actionId}/step': Op<{ id: string | number; actionId: string | number }, {
        draft?: '0' | '1' | 'true' | 'false';
    }, {
        actionResults?: Record<string, unknown> | null;
        callPath?: Array<number>;
        error?: {
            attempts: number;
            code?: string | null;
            message: string;
            step: string;
            stepIndex?: number;
            [key: string]: unknown;
        };
        formValues?: Record<string, unknown> | null;
        forms?: Record<string, unknown> | null;
        index?: number | null;
        item?: unknown;
        kind?: string;
        params?: Record<string, unknown> | null;
        runKey?: string;
        screenParams?: Record<string, unknown> | null;
        stepIndex: number;
        value?: unknown;
        vars?: Record<string, unknown> | null;
    }>;
    'POST /api/studio-apps/{id}/actions/{actionId}/step/stream': Op<{ id: string | number; actionId: string | number }, {
        draft?: '0' | '1' | 'true' | 'false';
    }, {
        actionResults?: Record<string, unknown> | null;
        callPath?: Array<number>;
        error?: {
            attempts: number;
            code?: string | null;
            message: string;
            step: string;
            stepIndex?: number;
            [key: string]: unknown;
        };
        formValues?: Record<string, unknown> | null;
        forms?: Record<string, unknown> | null;
        index?: number;
        item?: unknown;
        kind?: string;
        params?: Record<string, unknown> | null;
        runKey?: string;
        screenParams?: Record<string, unknown> | null;
        stepIndex: number | string;
        value?: unknown;
        vars?: Record<string, unknown> | null;
    }>;
    'POST /api/studio-apps/{id}/ai/chat': Op<{ id: string | number }, {
        draft?: '0' | '1' | 'true' | 'false';
    }, {
        messages: Array<{
            content?: unknown;
            role?: string;
            [key: string]: unknown;
        }>;
        nodeId: string;
    }>;
    'GET /api/studio-apps/{id}/assets': Op<{ id: string | number }>;
    'POST /api/studio-apps/{id}/assets': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/studio-apps/{id}/assets/{assetId}': Op<{ id: string | number; assetId: string | number }>;
    'DELETE /api/studio-apps/{id}/assets/{assetId}': Op<{ id: string | number; assetId: string | number }>;
    'POST /api/studio-apps/{id}/check': Op<{ id: string | number }, UndeclaredQuery, {
        asRole?: string | null;
        screenId?: string | null;
    }>;
    'POST /api/studio-apps/{id}/data/attachments': Op<{ id: string | number }, UndeclaredQuery, {
        fieldKey?: string;
        recordId?: string;
    }>;
    'POST /api/studio-apps/{id}/data/attachments/materialize': Op<{ id: string | number }, UndeclaredQuery, {
        attachmentId: string;
        inline?: boolean;
        recordId?: string | null;
        tableId?: string | null;
    }>;
    'GET /api/studio-apps/{id}/data/attachments/{fileId}': Op<{ id: string | number; fileId: string | number }>;
    'DELETE /api/studio-apps/{id}/data/attachments/{fileId}': Op<{ id: string | number; fileId: string | number }>;
    'GET /api/studio-apps/{id}/data/attachments/{fileId}/preview': Op<{ id: string | number; fileId: string | number }>;
    'POST /api/studio-apps/{id}/data/batch': Op<{ id: string | number }, UndeclaredQuery, {
        reads?: unknown;
    }>;
    'GET /api/studio-apps/{id}/data/connectors': Op<{ id: string | number }>;
    'GET /api/studio-apps/{id}/data/connectors/sync-status': Op<{ id: string | number }>;
    'POST /api/studio-apps/{id}/data/connectors/{connectorId}/inspect': Op<{ id: string | number; connectorId: string | number }, UndeclaredQuery, {
        params?: Record<string, unknown> | null;
    }>;
    'POST /api/studio-apps/{id}/data/connectors/{connectorId}/run': Op<{ id: string | number; connectorId: string | number }, UndeclaredQuery, {
        params?: Record<string, unknown> | null;
    }>;
    'POST /api/studio-apps/{id}/data/connectors/{connectorId}/sync': Op<{ id: string | number; connectorId: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/studio-apps/{id}/data/connectors/{connectorId}/verify': Op<{ id: string | number; connectorId: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/studio-apps/{id}/data/empty': Op<{ id: string | number }, UndeclaredQuery, {
        tableIds?: Array<string>;
    }>;
    'GET /api/studio-apps/{id}/data/export': Op<{ id: string | number }>;
    'POST /api/studio-apps/{id}/data/query': Op<{ id: string | number }, {
        refresh?: '0' | '1' | 'true' | 'false';
    }>;
    'GET /api/studio-apps/{id}/data/tables': Op<{ id: string | number }>;
    'GET /api/studio-apps/{id}/data/tables/{tableId}/records': Op<{ id: string | number; tableId: string | number }, {
        cursor?: string;
        expand?: string;
        fields?: string;
        filter?: string;
        limit?: number;
        match?: 'all' | 'any';
        orderBy?: string;
        sample?: '0' | '1';
        search?: string;
        sort?: string;
        total?: '0' | '1';
    }>;
    'POST /api/studio-apps/{id}/data/tables/{tableId}/records': Op<{ id: string | number; tableId: string | number }>;
    'GET /api/studio-apps/{id}/data/tables/{tableId}/records/{recordId}': Op<{ id: string | number; tableId: string | number; recordId: string | number }>;
    'PATCH /api/studio-apps/{id}/data/tables/{tableId}/records/{recordId}': Op<{ id: string | number; tableId: string | number; recordId: string | number }>;
    'DELETE /api/studio-apps/{id}/data/tables/{tableId}/records/{recordId}': Op<{ id: string | number; tableId: string | number; recordId: string | number }>;
    'GET /api/studio-apps/{id}/datasets': Op<{ id: string | number }>;
    'POST /api/studio-apps/{id}/datasets': Op<{ id: string | number }, UndeclaredQuery, {
        cacheTtlSeconds?: number;
        descriptor?: Record<string, unknown>;
        name?: string;
        source?: Record<string, unknown>;
        tableId?: string | null;
    }>;
    'PUT /api/studio-apps/{id}/datasets/{datasetId}': Op<{ id: string | number; datasetId: string | number }, UndeclaredQuery, {
        cacheTtlSeconds?: number;
        descriptor?: Record<string, unknown>;
        name?: string;
        source?: Record<string, unknown>;
        tableId?: string | null;
    }>;
    'DELETE /api/studio-apps/{id}/datasets/{datasetId}': Op<{ id: string | number; datasetId: string | number }>;
    'PUT /api/studio-apps/{id}/definition': Op<{ id: string | number }, UndeclaredQuery, {
        baseVersion: number;
        definition: Record<string, unknown>;
    }>;
    'GET /api/studio-apps/{id}/documents': Op<{ id: string | number }, {
        draft?: '0' | '1' | 'true' | 'false';
        node: string;
        q?: string;
    }>;
    'POST /api/studio-apps/{id}/documents/compare': Op<{ id: string | number }, {
        draft?: '0' | '1' | 'true' | 'false';
    }, {
        left: {
            documentId: string;
            versionId?: string | null;
        };
        node: string;
        right: {
            documentId: string;
            versionId?: string | null;
        };
    }>;
    'GET /api/studio-apps/{id}/documents/{docId}': Op<{ id: string | number; docId: string | number }, {
        draft?: '0' | '1' | 'true' | 'false';
        node: string;
        version?: string;
    }>;
    'GET /api/studio-apps/{id}/documents/{docId}/versions': Op<{ id: string | number; docId: string | number }, {
        draft?: '0' | '1' | 'true' | 'false';
        node: string;
    }>;
    'GET /api/studio-apps/{id}/large-datasets': Op<{ id: string | number }>;
    'POST /api/studio-apps/{id}/large-datasets': Op<{ id: string | number }, UndeclaredQuery, {
        bytes: number;
        kind?: 'vcf';
        name: string;
    }>;
    'GET /api/studio-apps/{id}/large-datasets/{datasetId}': Op<{ id: string | number; datasetId: string | number }>;
    'DELETE /api/studio-apps/{id}/large-datasets/{datasetId}': Op<{ id: string | number; datasetId: string | number }>;
    'POST /api/studio-apps/{id}/large-datasets/{datasetId}/complete': Op<{ id: string | number; datasetId: string | number }, UndeclaredQuery, Record<string, never>>;
    'PUT /api/studio-apps/{id}/large-datasets/{datasetId}/parts/{n}': Op<{ id: string | number; datasetId: string | number; n: string | number }>;
    'GET /api/studio-apps/{id}/members': Op<{ id: string | number }>;
    'POST /api/studio-apps/{id}/members': Op<{ id: string | number }, UndeclaredQuery, {
        roleKey?: string;
        userId: string;
    }>;
    'DELETE /api/studio-apps/{id}/members/{userId}': Op<{ id: string | number; userId: string | number }>;
    'PATCH /api/studio-apps/{id}/nextcloud-menu': Op<{ id: string | number }, UndeclaredQuery, {
        enabled: boolean;
    }>;
    'GET /api/studio-apps/{id}/public-pages': Op<{ id: string | number }>;
    'POST /api/studio-apps/{id}/public-pages': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'DELETE /api/studio-apps/{id}/public-pages/{token}': Op<{ id: string | number; token: string | number }>;
    'PATCH /api/studio-apps/{id}/publish': Op<{ id: string | number }, UndeclaredQuery, {
        isPublished: boolean;
        sharedGroups?: Array<string>;
    }>;
    'GET /api/studio-apps/{id}/ref': Op<{ id: string | number }, {
        nodeId?: string;
        screenId?: string;
    }>;
    'GET /api/studio-apps/{id}/runs': Op<{ id: string | number }, {
        actionId?: string;
        cursor?: string;
        limit?: string;
        origin?: string;
        since?: string;
        status?: 'running' | 'success' | 'error' | 'interrupted' | 'cancelled' | 'refused' | 'paused';
        user?: string;
    }>;
    'GET /api/studio-apps/{id}/runs/{runId}': Op<{ id: string | number; runId: string | number }>;
    'GET /api/studio-apps/{id}/runtime': Op<{ id: string | number }, {
        draft?: '0' | '1';
    }>;
    'GET /api/studio-apps/{id}/runtime/connectors/status': Op<{ id: string | number }>;
    'POST /api/studio-apps/{id}/runtime/connectors/{connectorId}/refresh': Op<{ id: string | number; connectorId: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/studio-apps/{id}/schema': Op<{ id: string | number }>;
    'PUT /api/studio-apps/{id}/schema': Op<{ id: string | number }, UndeclaredQuery, {
        dryRun?: boolean;
        expectedVersion?: number | null;
        model: Record<string, unknown>;
        onUnconvertible?: 'refuse' | 'clear';
    }>;
    'POST /api/studio-apps/{id}/template-upgrade': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/studio-apps/{id}/triggers': Op<{ id: string | number }>;
    'PUT /api/studio-apps/{id}/triggers/{triggerId}': Op<{ id: string | number; triggerId: string | number }, UndeclaredQuery, {
        enabled: boolean;
    }>;
    'GET /api/studio-apps/{id}/triggers/{triggerId}/webhook': Op<{ id: string | number; triggerId: string | number }>;
    'POST /api/studio-apps/{id}/triggers/{triggerId}/webhook/rotate': Op<{ id: string | number; triggerId: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/studio-apps/{id}/triggers/{triggerId}/webhook/secret': Op<{ id: string | number; triggerId: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/studio-apps/{id}/versions': Op<{ id: string | number }>;
    'POST /api/studio-apps/{id}/versions/{versionId}/restore': Op<{ id: string | number; versionId: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/studio-documents': Op<NoParams, {
        archived?: '0' | '1';
        category?: string;
        docType?: string;
        folderId?: string;
        kind?: 'document' | 'template' | 'section';
        limit?: number;
        offset?: number;
        query?: string;
        sort?: 'updated' | 'name';
        visibility?: 'private' | 'team';
    }>;
    'POST /api/studio-documents': Op;
    'GET /api/studio-documents/folders': Op;
    'POST /api/studio-documents/folders': Op<NoParams, UndeclaredQuery, {
        name: string;
        parentId?: string | null;
    }>;
    'DELETE /api/studio-documents/folders/{folderId}': Op<{ folderId: string | number }>;
    'GET /api/studio-documents/house-style': Op;
    'PUT /api/studio-documents/house-style': Op;
    'POST /api/studio-documents/house-style/deck-template': Op<NoParams, UndeclaredQuery, {
        dataUrl: string;
        name?: string;
    }>;
    'POST /api/studio-documents/house-style/preview-theme': Op;
    'PATCH /api/studio-documents/notebooks/{id}/filing': Op<{ id: string | number }, UndeclaredQuery, {
        categories?: Array<string>;
        folderId?: string | null;
    }>;
    'GET /api/studio-documents/notebooks/{id}/sharing': Op<{ id: string | number }>;
    'PUT /api/studio-documents/notebooks/{id}/sharing': Op<{ id: string | number }, UndeclaredQuery, {
        access?: 'view' | 'edit';
        audience: 'private' | 'organisation' | 'restricted';
        sharedGroups?: Array<string>;
        sharedUserIds?: Array<string>;
    }>;
    'GET /api/studio-documents/notebooks/{id}/sharing/principals': Op<{ id: string | number }>;
    'POST /api/studio-documents/sheets': Op<NoParams, UndeclaredQuery, {
        folderId?: string | null;
        name?: string;
    }>;
    'GET /api/studio-documents/starters': Op<NoParams, {
        locale?: string;
    }>;
    'GET /api/studio-documents/templates': Op<NoParams, {
        category?: string;
        docType?: string;
        folderId?: string;
        kind?: 'document' | 'template' | 'section';
        limit?: number;
        query?: string;
        sort?: 'updated' | 'name';
        visibility?: 'private' | 'team';
    }>;
    'GET /api/studio-documents/{id}': Op<{ id: string | number }>;
    'PATCH /api/studio-documents/{id}': Op<{ id: string | number }>;
    'DELETE /api/studio-documents/{id}': Op<{ id: string | number }>;
    'POST /api/studio-documents/{id}/ai-proposal': Op<{ id: string | number }, UndeclaredQuery, {
        history?: Array<{
            content?: unknown;
            role: string;
            [key: string]: unknown;
        }>;
        message: string;
        mode?: 'design' | 'content' | 'applicability';
        values?: Record<string, unknown> | null;
    }>;
    'GET /api/studio-documents/{id}/contract': Op<{ id: string | number }, {
        versionId?: string;
    }>;
    'POST /api/studio-documents/{id}/duplicate': Op<{ id: string | number }, UndeclaredQuery, {
        kind?: 'document' | 'template' | 'section';
        name?: string;
    }>;
    'POST /api/studio-documents/{id}/insert-section': Op<{ id: string | number }, UndeclaredQuery, {
        expectedVersionId?: string;
        sourceId: string;
    }>;
    'GET /api/studio-documents/{id}/pdf': Op<{ id: string | number }, {
        versionId?: string;
    }>;
    'GET /api/studio-documents/{id}/pptx': Op<{ id: string | number }, {
        versionId?: string;
    }>;
    'POST /api/studio-documents/{id}/presence': Op<{ id: string | number }, UndeclaredQuery, {
        clientId: string;
        sectionId?: string | null;
        state: 'viewing' | 'editing' | 'left';
    }>;
    'GET /api/studio-documents/{id}/preview': Op<{ id: string | number }, {
        edit?: '0' | '1';
    }>;
    'POST /api/studio-documents/{id}/preview': Op<{ id: string | number }, UndeclaredQuery, {
        bodyHtml?: string;
        settings?: Record<string, unknown> | null;
    }>;
    'POST /api/studio-documents/{id}/preview-changes': Op<{ id: string | number }, UndeclaredQuery, {
        deck?: Record<string, unknown> | null;
        design?: Record<string, unknown> | null;
    }>;
    'POST /api/studio-documents/{id}/review-update': Op<{ id: string | number }, UndeclaredQuery, {
        sectionId?: string | null;
    }>;
    'GET /api/studio-documents/{id}/sections/{sectionId}': Op<{ id: string | number; sectionId: string | number }>;
    'POST /api/studio-documents/{id}/sections/{sectionId}/save': Op<{ id: string | number; sectionId: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/studio-documents/{id}/sharing': Op<{ id: string | number }>;
    'PUT /api/studio-documents/{id}/sharing': Op<{ id: string | number }, UndeclaredQuery, {
        access?: 'view' | 'edit';
        audience: 'private' | 'organisation' | 'restricted';
        sharedGroups?: Array<string>;
        sharedUserIds?: Array<string>;
    }>;
    'GET /api/studio-documents/{id}/sharing/principals': Op<{ id: string | number }>;
    'GET /api/studio-documents/{id}/sheet': Op<{ id: string | number }>;
    'PATCH /api/studio-documents/{id}/sheet': Op<{ id: string | number }, UndeclaredQuery, {
        cells: Record<string, string | null>;
    }>;
    'GET /api/studio-documents/{id}/sheet.csv': Op<{ id: string | number }>;
    'GET /api/studio-documents/{id}/sheet.xlsx': Op<{ id: string | number }>;
    'POST /api/studio-documents/{id}/sheet/assistant': Op<{ id: string | number }, UndeclaredQuery, {
        history?: Array<{
            content: string;
            role: 'user' | 'assistant';
            [key: string]: unknown;
        }>;
        message: string;
        modelTier?: 'auto' | 'fast' | 'thinking' | 'pro' | 'deep_thinking';
        selection?: string | null;
        selectionKind?: 'cell' | 'range' | 'rows' | 'columns' | null;
        tab?: string;
    }>;
    'POST /api/studio-documents/{id}/sheet/tabs': Op<{ id: string | number }, UndeclaredQuery, {
        name?: string;
    }>;
    'PATCH /api/studio-documents/{id}/sheet/tabs/{tabId}': Op<{ id: string | number; tabId: string | number }, UndeclaredQuery, {
        name: string;
    }>;
    'DELETE /api/studio-documents/{id}/sheet/tabs/{tabId}': Op<{ id: string | number; tabId: string | number }>;
    'GET /api/studio-documents/{id}/stream': Op<{ id: string | number }>;
    'GET /api/studio-documents/{id}/suggestions': Op<{ id: string | number }>;
    'POST /api/studio-documents/{id}/suggestions/batch/{batchId}/accept': Op<{ id: string | number; batchId: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/studio-documents/{id}/suggestions/batch/{batchId}/reject': Op<{ id: string | number; batchId: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/studio-documents/{id}/suggestions/{sid}/accept': Op<{ id: string | number; sid: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/studio-documents/{id}/suggestions/{sid}/reject': Op<{ id: string | number; sid: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/studio-documents/{id}/unarchive': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/studio-documents/{id}/updates': Op<{ id: string | number }>;
    'POST /api/studio-documents/{id}/validate': Op<{ id: string | number }, UndeclaredQuery, {
        sectionOverrides?: Record<string, unknown> | null;
        values?: Record<string, unknown> | null;
    }>;
    'GET /api/studio-documents/{id}/versions': Op<{ id: string | number }, {
        cursor?: string;
        limit?: number;
    }>;
    'POST /api/studio-documents/{id}/versions': Op<{ id: string | number }, UndeclaredQuery, {
        name: string;
    }>;
    'GET /api/studio-documents/{id}/versions/{ref}': Op<{ id: string | number; ref: string | number }>;
    'DELETE /api/studio-documents/{id}/versions/{ref}': Op<{ id: string | number; ref: string | number }>;
    'PUT /api/studio-documents/{id}/versions/{ref}/name': Op<{ id: string | number; ref: string | number }, UndeclaredQuery, {
        name: string | null;
    }>;
    'POST /api/studio-documents/{id}/versions/{ref}/restore': Op<{ id: string | number; ref: string | number }, UndeclaredQuery, {
        expectedVersion?: string;
        expectedVersionId?: string;
    }>;
    'POST /api/studio/ai/route': Op<NoParams, UndeclaredQuery, {
        text?: string | null;
    }>;
    'GET /api/studio/attention': Op;
    'GET /api/studio/counts': Op;
    'GET /api/studio/search': Op<NoParams, {
        q?: string;
    }>;
    'GET /api/subscriptions/audit': Op<NoParams, {
        limit?: number;
        offset?: number;
        targetId?: string;
        targetType?: string;
    }>;
    'GET /api/subscriptions/consumer/usage': Op;
    'POST /api/subscriptions/consumer/{userId}/cancel': Op<{ userId: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/subscriptions/consumer/{userId}/reactivate': Op<{ userId: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/subscriptions/consumer/{userId}/reissue-license': Op<{ userId: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/subscriptions/consumer/{userId}/start-trial': Op<{ userId: string | number }, UndeclaredQuery, {
        plan_id: string;
    }>;
    'POST /api/subscriptions/consumer/{userId}/upgrade': Op<{ userId: string | number }, UndeclaredQuery, {
        planId: string;
    }>;
    'GET /api/subscriptions/currency-rates': Op;
    'PUT /api/subscriptions/currency-rates': Op<NoParams, UndeclaredQuery, Record<string, number>>;
    'GET /api/subscriptions/license-issuance-failures': Op<NoParams, {
        limit?: number;
    }>;
    'GET /api/subscriptions/orgs': Op;
    'GET /api/subscriptions/orgs/{orgId}': Op<{ orgId: string | number }>;
    'PUT /api/subscriptions/orgs/{orgId}': Op<{ orgId: string | number }, UndeclaredQuery, {
        allowed_features?: Array<string> | null;
        allowed_models?: Array<string> | null;
        billing_cycle_start?: string | null;
        cancel_at?: string | null;
        cancel_at_period_end?: boolean | null;
        current_period_end?: string | null;
        last_payment_failure_at?: string | null;
        manual_override_by?: string | null;
        manual_override_until?: string | null;
        max_agents?: number | null;
        max_cost_per_month?: number | null;
        max_knowledge_sources?: number | null;
        max_messages_by_type?: Record<string, number> | null;
        max_messages_per_month?: number | null;
        max_tokens_per_month?: number | null;
        max_users?: number | null;
        notes?: string | null;
        override_hours?: number;
        past_due_since?: string | null;
        payment_attempt_count?: number | null;
        payment_status?: string | null;
        pending_plan_effective?: string | null;
        pending_plan_id?: string | null;
        plan_id?: string | null;
        status?: 'active' | 'suspended' | 'cancelled' | 'trialing' | 'past_due' | 'manual_action_required';
        stripe_customer_id?: string | null;
        stripe_schedule_id?: string | null;
        stripe_seat_quantity?: number | null;
        stripe_subscription_id?: string | null;
        trial_end_date?: string | null;
    }>;
    'DELETE /api/subscriptions/orgs/{orgId}': Op<{ orgId: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/subscriptions/orgs/{orgId}/cancel': Op<{ orgId: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/subscriptions/orgs/{orgId}/cancel-downgrade': Op<{ orgId: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/subscriptions/orgs/{orgId}/effective-access': Op<{ orgId: string | number }>;
    'POST /api/subscriptions/orgs/{orgId}/preview-change': Op<{ orgId: string | number }, UndeclaredQuery, {
        planId: string;
    }>;
    'POST /api/subscriptions/orgs/{orgId}/reactivate': Op<{ orgId: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/subscriptions/orgs/{orgId}/reissue-license': Op<{ orgId: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/subscriptions/orgs/{orgId}/start-trial': Op<{ orgId: string | number }, UndeclaredQuery, {
        plan_id: string;
    }>;
    'POST /api/subscriptions/orgs/{orgId}/upgrade': Op<{ orgId: string | number }, UndeclaredQuery, {
        planId: string;
    }>;
    'GET /api/subscriptions/orgs/{orgId}/usage': Op<{ orgId: string | number }>;
    'GET /api/subscriptions/plans': Op;
    'POST /api/subscriptions/plans': Op<NoParams, UndeclaredQuery, {
        allowed_beta_features?: Array<string> | null;
        allowed_features?: Array<string> | null;
        allowed_integrations?: Array<string> | null;
        allowed_models?: Array<string> | null;
        billing_interval?: 'monthly' | 'yearly';
        billing_model?: 'fixed' | 'metered';
        currency?: string;
        description?: string | null;
        id?: string;
        is_default?: boolean;
        is_public?: boolean;
        markup_percent?: number;
        max_agents?: number | null;
        max_cost_per_month?: number | null;
        max_knowledge_sources?: number | null;
        max_messages_by_type?: Record<string, number> | null;
        max_messages_per_month?: number | null;
        max_messages_per_seat?: number | null;
        max_tokens_per_month?: number | null;
        max_users?: number | null;
        name: string;
        nc_only?: boolean;
        nc_recommended?: boolean;
        per_seat?: boolean;
        plan_type?: 'organization' | 'consumer';
        price?: number | null;
        sort_order?: number | null;
        stripe_meter_event_name?: string | null;
        stripe_meter_id?: string | null;
        stripe_price_id?: string | null;
        stripe_product_id?: string | null;
        tagline?: string | null;
        tier?: 'pro' | 'enterprise' | '' | null;
        trial_days?: number | null;
    }>;
    'PUT /api/subscriptions/plans/{id}': Op<{ id: string | number }, UndeclaredQuery, {
        allowed_beta_features?: Array<string> | null;
        allowed_features?: Array<string> | null;
        allowed_integrations?: Array<string> | null;
        allowed_models?: Array<string> | null;
        billing_interval?: 'monthly' | 'yearly';
        billing_model?: 'fixed' | 'metered';
        currency?: string;
        description?: string | null;
        is_default?: boolean;
        is_public?: boolean;
        markup_percent?: number;
        max_agents?: number | null;
        max_cost_per_month?: number | null;
        max_knowledge_sources?: number | null;
        max_messages_by_type?: Record<string, number> | null;
        max_messages_per_month?: number | null;
        max_messages_per_seat?: number | null;
        max_tokens_per_month?: number | null;
        max_users?: number | null;
        name?: string;
        nc_only?: boolean;
        nc_recommended?: boolean;
        per_seat?: boolean;
        plan_type?: 'organization' | 'consumer';
        price?: number | null;
        sort_order?: number | null;
        stripe_meter_event_name?: string | null;
        stripe_meter_id?: string | null;
        stripe_price_id?: string | null;
        stripe_product_id?: string | null;
        tagline?: string | null;
        tier?: 'pro' | 'enterprise' | '' | null;
        trial_days?: number | null;
    }>;
    'DELETE /api/subscriptions/plans/{id}': Op<{ id: string | number }>;
    'POST /api/subscriptions/plans/{id}/sync-stripe': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/subscriptions/registries': Op;
    'GET /api/subscriptions/trial-config': Op;
    'PUT /api/subscriptions/trial-config': Op<NoParams, UndeclaredQuery, {
        default_consumer_trial_plan_id?: string | null;
        default_org_trial_plan_id?: string | null;
    }>;
    'GET /api/summary-templates': Op;
    'POST /api/summary-templates': Op<NoParams, UndeclaredQuery, {
        groupId?: string;
        isDefault?: boolean;
        name: string;
        prompt: string;
        scope?: 'user' | 'org' | 'group';
    }>;
    'GET /api/summary-templates/org': Op;
    'PATCH /api/summary-templates/{id}': Op<{ id: string | number }, UndeclaredQuery, {
        isDefault?: boolean;
        name?: string;
        prompt?: string;
    }>;
    'DELETE /api/summary-templates/{id}': Op<{ id: string | number }>;
    'GET /api/support-inbox/audit': Op<NoParams, {
        action?: string;
        actor?: string;
        cursor?: string;
        from?: string;
        inbox?: string;
        limit?: number;
        to?: string;
    }>;
    'GET /api/support-inbox/canned': Op;
    'POST /api/support-inbox/canned': Op<NoParams, UndeclaredQuery, {
        body: string;
        shortcut?: string | null;
        title: string;
    }>;
    'PUT /api/support-inbox/canned/{id}': Op<{ id: string | number }, UndeclaredQuery, {
        body?: string;
        shortcut?: string | null;
        title?: string;
    }>;
    'DELETE /api/support-inbox/canned/{id}': Op<{ id: string | number }>;
    'GET /api/support-inbox/inboxes': Op;
    'POST /api/support-inbox/inboxes': Op<NoParams, UndeclaredQuery, {
        autoresolveThreshold?: number;
        defaultAgentId?: string | null;
        displayName?: string;
        folderFilter?: Array<string>;
        kbIds?: Array<string>;
        organizationId?: string;
        provider: 'gmail' | 'outlook';
        replyMode?: 'draft' | 'auto_confident' | 'autonomous';
        signature?: string | null;
        toolsEnabled?: boolean;
    }>;
    'PATCH /api/support-inbox/inboxes/{id}': Op<{ id: string | number }, UndeclaredQuery, {
        active?: boolean;
        autoresolve_threshold?: number;
        classify_non_support_enabled?: boolean;
        classify_sensitivity?: number;
        classify_suppress_autoreply?: boolean;
        default_agent_id?: string | null;
        display_name?: string;
        enabled_tool_ids?: Array<string>;
        folder_filter?: Array<string>;
        kb_ids?: Array<string> | null;
        operator_user_id?: string | null;
        reply_mode?: 'draft' | 'auto_confident' | 'autonomous';
        signature?: string | null;
        sync_interval_minutes?: number;
        tools_enabled?: boolean;
    }>;
    'DELETE /api/support-inbox/inboxes/{id}': Op<{ id: string | number }>;
    'GET /api/support-inbox/inboxes/{id}/access': Op<{ id: string | number }>;
    'PUT /api/support-inbox/inboxes/{id}/access': Op<{ id: string | number }, UndeclaredQuery, {
        sharedGroups: Array<string>;
    }>;
    'GET /api/support-inbox/inboxes/{id}/audit': Op<{ id: string | number }, {
        action?: string;
        actor?: string;
        cursor?: string;
        from?: string;
        limit?: number;
        to?: string;
    }>;
    'GET /api/support-inbox/inboxes/{id}/available-integrations': Op<{ id: string | number }, {
        operator?: string;
    }>;
    'POST /api/support-inbox/inboxes/{id}/disconnect': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'PUT /api/support-inbox/inboxes/{id}/kb-automation': Op<{ id: string | number }, UndeclaredQuery, {
        enabled: boolean;
        knowledgeBaseId?: string | null;
    }>;
    'GET /api/support-inbox/inboxes/{id}/oauth/start': Op<{ id: string | number }>;
    'GET /api/support-inbox/inboxes/{id}/scan': Op<{ id: string | number }>;
    'POST /api/support-inbox/inboxes/{id}/scan': Op<{ id: string | number }, UndeclaredQuery, {
        windowDays?: number;
    }>;
    'GET /api/support-inbox/inboxes/{id}/settings': Op<{ id: string | number }>;
    'GET /api/support-inbox/insights': Op<NoParams, {
        inbox?: string;
    }>;
    'GET /api/support-inbox/oauth/callback': Op;
    'GET /api/support-inbox/sla-policies': Op;
    'PUT /api/support-inbox/sla-policies': Op<NoParams, UndeclaredQuery, {
        enabled?: boolean;
        firstResponseMinutes: number;
        priority: 'low' | 'normal' | 'high' | 'urgent';
        resolutionMinutes: number;
    }>;
    'GET /api/support-inbox/stream': Op;
    'GET /api/support-inbox/tags': Op;
    'POST /api/support-inbox/tags': Op<NoParams, UndeclaredQuery, {
        color?: string | null;
        description?: string | null;
        name: string;
    }>;
    'DELETE /api/support-inbox/tags/{id}': Op<{ id: string | number }>;
    'GET /api/support-inbox/teammates': Op;
    'GET /api/support-inbox/threads': Op<NoParams, {
        assignee?: string;
        excludeFiltered?: '0' | '1';
        inbox?: string;
        limit?: number;
        offset?: number;
        q?: string;
        status?: string;
        tag?: string;
    }>;
    'GET /api/support-inbox/threads/{id}': Op<{ id: string | number }>;
    'PATCH /api/support-inbox/threads/{id}': Op<{ id: string | number }, UndeclaredQuery, {
        assignee_user_id?: string | null;
        category?: string | null;
        markNotSupport?: boolean;
        priority?: 'low' | 'normal' | 'high' | 'urgent';
        status?: 'open' | 'ai_responding' | 'awaiting_user' | 'awaiting_agent' | 'resolved' | 'closed';
        tags?: Array<string>;
        unfilter?: boolean;
    }>;
    'GET /api/support-inbox/threads/{id}/context': Op<{ id: string | number }>;
    'POST /api/support-inbox/threads/{id}/draft': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/support-inbox/threads/{id}/events': Op<{ id: string | number }>;
    'POST /api/support-inbox/threads/{id}/reply': Op<{ id: string | number }, UndeclaredQuery, {
        body: string;
        bodyHtml?: string | null;
        internalNote?: boolean;
    }>;
    'GET /api/support/agent': Op;
    'PUT /api/support/agent': Op<NoParams, UndeclaredQuery, {
        config?: Record<string, unknown>;
        description?: string | null;
        knowledgeBaseIds?: Array<string>;
        model?: string | null;
        name?: string;
        starterPrompts?: Array<string>;
        systemPrompt?: string | null;
    }>;
    'GET /api/support/canned': Op;
    'POST /api/support/canned': Op<NoParams, UndeclaredQuery, {
        body: string;
        shortcut?: string | null;
        title: string;
    }>;
    'PUT /api/support/canned/{id}': Op<{ id: string | number }, UndeclaredQuery, {
        body?: string;
        shortcut?: string | null;
        title?: string;
    }>;
    'DELETE /api/support/canned/{id}': Op<{ id: string | number }>;
    'POST /api/support/canned/{id}/render': Op<{ id: string | number }, UndeclaredQuery, {
        threadId?: string;
    }>;
    'GET /api/support/config': Op;
    'PUT /api/support/config': Op<NoParams, UndeclaredQuery, {
        agentId?: string | null;
        autoResolveThreshold?: number;
        kbIds?: Array<string>;
        v2Enabled?: boolean;
    }>;
    'GET /api/support/csat/{threadId}': Op<{ threadId: string | number }>;
    'GET /api/support/csat/{threadId}/done': Op<{ threadId: string | number }>;
    'GET /api/support/insights': Op;
    'GET /api/support/mailbox': Op;
    'POST /api/support/mailbox/disconnect': Op<NoParams, UndeclaredQuery, Record<string, never>>;
    'GET /api/support/notifications': Op;
    'PUT /api/support/notifications': Op<NoParams, UndeclaredQuery, {
        enabled?: boolean;
        events?: Array<string>;
        provider?: string;
        webhookUrl?: string | null;
    }>;
    'POST /api/support/notifications/test': Op<NoParams, UndeclaredQuery, Record<string, never>>;
    'POST /api/support/preview': Op<NoParams, UndeclaredQuery, {
        message: string;
    }>;
    'GET /api/support/sla-policies': Op;
    'PUT /api/support/sla-policies': Op<NoParams, UndeclaredQuery, {
        enabled?: boolean;
        first_response_minutes: number;
        priority: 'low' | 'normal' | 'high' | 'urgent';
        resolution_minutes: number;
    }>;
    'GET /api/support/stream': Op;
    'GET /api/support/t/{id}/open': Op<{ id: string | number }, {
        token?: string;
    }>;
    'GET /api/support/tags': Op;
    'POST /api/support/tags': Op<NoParams, UndeclaredQuery, {
        color?: string | null;
        description?: string | null;
        name: string;
    }>;
    'DELETE /api/support/tags/{id}': Op<{ id: string | number }>;
    'GET /api/support/threads': Op<NoParams, {
        assignee?: string;
        followup?: '0' | '1' | 'true' | 'false';
        limit?: number;
        offset?: number;
        q?: string;
        status?: string;
    }>;
    'POST /api/support/threads': Op<NoParams, UndeclaredQuery, {
        email?: string | null;
        message: string;
        name?: string | null;
        rendered_at_ms?: unknown;
        source?: 'marketing' | 'in_app';
        subject: string;
        website_url?: unknown;
    }>;
    'POST /api/support/threads/bulk': Op<NoParams, UndeclaredQuery, {
        action: 'assign' | 'status' | 'priority' | 'tag' | 'resolve';
        ids: Array<string>;
        params?: {
            assignee_user_id?: string | null;
            priority?: 'low' | 'normal' | 'high' | 'urgent';
            status?: 'open' | 'ai_responding' | 'awaiting_user' | 'awaiting_agent' | 'resolved' | 'closed';
            tag?: string;
        };
    }>;
    'GET /api/support/threads/mine': Op;
    'GET /api/support/threads/{id}': Op<{ id: string | number }, {
        token?: string;
    }>;
    'PATCH /api/support/threads/{id}': Op<{ id: string | number }, UndeclaredQuery, {
        assignee_user_id?: string | null;
        category?: string | null;
        priority?: 'low' | 'normal' | 'high' | 'urgent';
        status?: 'open' | 'ai_responding' | 'awaiting_user' | 'awaiting_agent' | 'resolved' | 'closed';
        tags?: Array<string>;
    }>;
    'POST /api/support/threads/{id}/escalate': Op<{ id: string | number }, UndeclaredQuery, {
        issueId?: string | null;
        raisePriority?: boolean;
        reason: string;
    }>;
    'GET /api/support/threads/{id}/events': Op<{ id: string | number }>;
    'POST /api/support/threads/{id}/followup-done': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/support/threads/{id}/issues': Op<{ id: string | number }>;
    'POST /api/support/threads/{id}/issues': Op<{ id: string | number }, UndeclaredQuery, {
        issueId?: string;
        issueIds?: Array<string>;
        reason?: string | null;
    }>;
    'POST /api/support/threads/{id}/issues/create': Op<{ id: string | number }, UndeclaredQuery, {
        description?: string | null;
        projectId?: string | null;
        reason?: string | null;
        summary?: string | null;
    }>;
    'POST /api/support/threads/{id}/issues/refresh': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'DELETE /api/support/threads/{id}/issues/{issueId}': Op<{ id: string | number; issueId: string | number }>;
    'POST /api/support/threads/{id}/messages': Op<{ id: string | number }, {
        token?: string;
    }, {
        body: string;
        internalNote?: boolean;
    }>;
    'PUT /api/support/youtrack/connection': Op<NoParams, UndeclaredQuery, {
        includeSubject?: boolean;
        project?: string | null;
        token?: string | null;
        url?: string | null;
    }>;
    'GET /api/support/youtrack/issues/{issueId}/threads': Op<{ issueId: string | number }>;
    'GET /api/support/youtrack/search': Op<NoParams, {
        q?: string;
        threadId?: string;
    }>;
    'GET /api/support/youtrack/status': Op;
    'GET /api/talk-notes-settings/user/me': Op;
    'PUT /api/talk-notes-settings/user/me': Op<NoParams, UndeclaredQuery, {
        autoRecord?: boolean;
        autoRecordScope?: 'calendar' | 'all';
        autoTranscribe?: boolean;
        excludedEventUids?: Array<unknown>;
        excludedRoomTokens?: Array<unknown>;
        language?: string;
        nextcloudConnected?: unknown;
        postSummaryBack?: boolean;
        recordingEnabled?: unknown;
        recordingFolder?: string;
        recordingMode?: 'audio' | 'video';
        updatedAt?: unknown;
        updatedBy?: unknown;
    }>;
    'GET /api/talk-notes-settings/{orgId}': Op<{ orgId: string | number }>;
    'PUT /api/talk-notes-settings/{orgId}': Op<{ orgId: string | number }, UndeclaredQuery, {
        autoRecord?: boolean | null;
        autoRecordScope?: 'calendar' | 'all' | null;
        autoTranscribe?: boolean | null;
        defaultOwnerUserId?: string | null;
        excludedEventUids?: Array<unknown>;
        excludedRoomTokens?: Array<unknown>;
        insightsPerPersonStats?: boolean;
        language?: string | null;
        postSummaryBack?: boolean | null;
        recordingFolder?: string | null;
        recordingMode?: 'audio' | 'video' | null;
        updatedAt?: unknown;
        updatedBy?: unknown;
    }>;
    'GET /api/teams-notes-settings/user/me': Op;
    'PUT /api/teams-notes-settings/user/me': Op<NoParams, UndeclaredQuery, {
        autoImport?: boolean | null;
        autoRecordConfig?: boolean | null;
        language?: string | null;
        lookbackHours?: number | null;
        updatedAt?: string | null;
        updatedBy?: string | null;
    }>;
    'GET /api/teams-notes-settings/{orgId}': Op<{ orgId: string | number }>;
    'PUT /api/teams-notes-settings/{orgId}': Op<{ orgId: string | number }, UndeclaredQuery, {
        autoImport?: boolean | null;
        autoRecordConfig?: boolean | null;
        language?: string | null;
        lookbackHours?: number | null;
        updatedAt?: string | null;
        updatedBy?: string | null;
    }>;
    'POST /api/teams-setup/me/diagnostics': Op<NoParams, UndeclaredQuery, Record<string, never>>;
    'GET /api/teams-setup/org/app-import': Op;
    'PUT /api/teams-setup/org/app-import': Op<NoParams, UndeclaredQuery, {
        coverage: 'all' | 'selected';
        enabled: boolean;
        selectedUserIds: Array<string>;
    }>;
    'POST /api/teams-setup/org/app-import/diagnostics': Op<NoParams, UndeclaredQuery, {
        probeUserId?: string;
    }>;
    'POST /api/teams-setup/org/consent-link': Op<NoParams, UndeclaredQuery, Record<string, never>>;
    'GET /api/teams-setup/org/overview': Op<NoParams, {
        days?: number;
    }>;
    'GET /api/teams-setup/requirements': Op;
    'GET /api/templates': Op;
    'GET /api/templates/download-filled/{filename}': Op<{ filename: string | number }>;
    'POST /api/templates/upload': Op<NoParams, UndeclaredQuery, {
        description?: string;
        instructions?: string;
        knowledgeBaseIds?: Array<string>;
        name?: string;
        skipAutoParameterize?: 'true' | 'false';
    }>;
    'GET /api/templates/{id}': Op<{ id: string | number }>;
    'PUT /api/templates/{id}': Op<{ id: string | number }, UndeclaredQuery, {
        description?: string;
        instructions?: string;
        knowledgeBaseIds?: Array<string>;
        name?: string;
    }>;
    'DELETE /api/templates/{id}': Op<{ id: string | number }>;
    'GET /api/templates/{id}/download': Op<{ id: string | number }>;
    'POST /api/templates/{id}/fill': Op<{ id: string | number }, UndeclaredQuery, {
        values: Record<string, unknown>;
    }>;
    'POST /api/templates/{id}/fill-and-store': Op<{ id: string | number }, UndeclaredQuery, {
        values: Record<string, unknown>;
    }>;
    'GET /api/terminations': Op<NoParams, {
        agent?: string;
        days?: string;
        endDate?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        reveal?: 'true' | 'false';
        startDate?: string;
        type?: 'max_tokens' | 'max_iterations' | 'error' | 'aborted';
        user?: string;
    }>;
    'GET /api/terminations/by-agent': Op<NoParams, {
        agent?: string;
        days?: string;
        endDate?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        reveal?: 'true' | 'false';
        startDate?: string;
        type?: 'max_tokens' | 'max_iterations' | 'error' | 'aborted';
        user?: string;
    }>;
    'GET /api/terminations/org': Op<NoParams, {
        agent?: string;
        days?: string;
        endDate?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        orgId?: string;
        reveal?: 'true' | 'false';
        startDate?: string;
        type?: 'max_tokens' | 'max_iterations' | 'error' | 'aborted';
        user?: string;
    }>;
    'GET /api/terminations/org/by-agent': Op<NoParams, {
        agent?: string;
        days?: string;
        endDate?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        orgId?: string;
        reveal?: 'true' | 'false';
        startDate?: string;
        type?: 'max_tokens' | 'max_iterations' | 'error' | 'aborted';
        user?: string;
    }>;
    'GET /api/terminations/org/summary': Op<NoParams, {
        agent?: string;
        days?: string;
        endDate?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        orgId?: string;
        reveal?: 'true' | 'false';
        startDate?: string;
        type?: 'max_tokens' | 'max_iterations' | 'error' | 'aborted';
        user?: string;
    }>;
    'GET /api/terminations/org/timeline': Op<NoParams, {
        agent?: string;
        days?: string;
        endDate?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        orgId?: string;
        reveal?: 'true' | 'false';
        startDate?: string;
        type?: 'max_tokens' | 'max_iterations' | 'error' | 'aborted';
        user?: string;
    }>;
    'GET /api/terminations/summary': Op<NoParams, {
        agent?: string;
        days?: string;
        endDate?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        reveal?: 'true' | 'false';
        startDate?: string;
        type?: 'max_tokens' | 'max_iterations' | 'error' | 'aborted';
        user?: string;
    }>;
    'GET /api/terminations/timeline': Op<NoParams, {
        agent?: string;
        days?: string;
        endDate?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        reveal?: 'true' | 'false';
        startDate?: string;
        type?: 'max_tokens' | 'max_iterations' | 'error' | 'aborted';
        user?: string;
    }>;
    'GET /api/transcriptions': Op<NoParams, {
        limit?: number;
        offset?: number;
    }>;
    'POST /api/transcriptions': Op<NoParams, UndeclaredQuery, {
        attendees?: string;
        capture_mode?: 'recording' | 'upload';
        client_upload_id?: string;
        context_terms?: string;
        language?: string;
        num_speakers?: number;
        projectId?: string;
        provider?: string;
        title?: string;
    }>;
    'POST /api/transcriptions/from-gmeet': Op<NoParams, UndeclaredQuery, {
        context_terms?: string;
        event_id?: string;
        language?: string;
        meet_link?: string;
        meeting_code?: string;
        title?: string;
    }>;
    'POST /api/transcriptions/from-nextcloud': Op<NoParams, UndeclaredQuery, {
        context_terms?: string;
        language?: string;
        nextcloud_path: string;
        provider?: string;
        title?: string;
    }>;
    'POST /api/transcriptions/from-teams': Op<NoParams, UndeclaredQuery, {
        context_terms?: string;
        event_id: string;
        language?: string;
    }>;
    'GET /api/transcriptions/gmeet-imports': Op;
    'GET /api/transcriptions/gmeet-meetings': Op;
    'PATCH /api/transcriptions/gmeet-meetings/{eventId}': Op<{ eventId: string | number }, UndeclaredQuery, {
        applyToSeries?: boolean;
        meetingCode?: string | null;
        organizerSelf?: boolean;
        record: boolean;
    }>;
    'GET /api/transcriptions/gmeet-recordings': Op;
    'GET /api/transcriptions/nextcloud-audio-files': Op<NoParams, {
        folder?: string;
    }>;
    'GET /api/transcriptions/nextcloud-talk-recordings': Op<NoParams, {
        folder?: string;
    }>;
    'POST /api/transcriptions/report': Op<NoParams, UndeclaredQuery, {
        ids: Array<string>;
        prompt: string;
    }>;
    'GET /api/transcriptions/tags': Op;
    'GET /api/transcriptions/talk-meetings': Op;
    'PATCH /api/transcriptions/talk-meetings/{token}': Op<{ token: string | number }, UndeclaredQuery, {
        eventUid?: string | null;
        record: boolean;
    }>;
    'GET /api/transcriptions/teams-imports': Op;
    'GET /api/transcriptions/teams-meetings': Op;
    'PATCH /api/transcriptions/teams-meetings/{eventId}': Op<{ eventId: string | number }, UndeclaredQuery, {
        applyToSeries?: boolean;
        record: boolean;
        seriesMasterId?: string | null;
    }>;
    'GET /api/transcriptions/teams-recordings': Op;
    'GET /api/transcriptions/{id}': Op<{ id: string | number }>;
    'PATCH /api/transcriptions/{id}': Op<{ id: string | number }, UndeclaredQuery, {
        actionItems?: Array<unknown>;
        decisions?: Array<unknown>;
        questions?: Array<unknown>;
        tags?: Array<unknown>;
        title?: string;
    }>;
    'DELETE /api/transcriptions/{id}': Op<{ id: string | number }, {
        confirm?: '0' | '1' | 'true' | 'false';
    }, Record<string, never>>;
    'GET /api/transcriptions/{id}/audio': Op<{ id: string | number }, {
        download?: '0' | '1' | 'true' | 'false';
    }>;
    'GET /api/transcriptions/{id}/export': Op<{ id: string | number }, {
        format?: 'md' | 'txt';
    }>;
    'DELETE /api/transcriptions/{id}/filed-lines': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'PATCH /api/transcriptions/{id}/publish': Op<{ id: string | number }, UndeclaredQuery, {
        isPublished: boolean;
        sharedGroups?: Array<string>;
    }>;
    'POST /api/transcriptions/{id}/regenerate-summary': Op<{ id: string | number }, UndeclaredQuery, {
        customPrompt?: string | null;
        template?: string;
        templateId?: string | null;
    }>;
    'POST /api/transcriptions/{id}/reidentify-speakers': Op<{ id: string | number }, UndeclaredQuery, {
        attendees?: string | Array<string>;
    }>;
    'POST /api/transcriptions/{id}/reprocess': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/transcriptions/{id}/series-previous': Op<{ id: string | number }>;
    'PATCH /api/transcriptions/{id}/speakers': Op<{ id: string | number }, UndeclaredQuery, {
        merges?: Array<unknown>;
        renames?: Record<string, unknown>;
    }>;
    'GET /api/transcriptions/{id}/usage': Op<{ id: string | number }>;
    'GET /api/usage/adoption/areas': Op<NoParams, {
        cursor?: number;
        days?: number;
        endDate?: string;
        group?: string;
        kind?: 'agent' | 'automation' | 'form' | 'app' | 'datatable' | 'kb' | 'skill' | 'webpage' | 'document' | 'meeting' | 'playbook' | 'solution' | 'cowork';
        limit?: number;
        orgId?: string;
        reveal?: 'true' | 'false';
        startDate?: string;
    }>;
    'GET /api/usage/adoption/groups': Op<NoParams, {
        cursor?: number;
        days?: number;
        endDate?: string;
        group?: string;
        kind?: 'agent' | 'automation' | 'form' | 'app' | 'datatable' | 'kb' | 'skill' | 'webpage' | 'document' | 'meeting' | 'playbook' | 'solution' | 'cowork';
        limit?: number;
        orgId?: string;
        reveal?: 'true' | 'false';
        startDate?: string;
    }>;
    'GET /api/usage/adoption/people': Op<NoParams, {
        cursor?: number;
        days?: number;
        endDate?: string;
        group?: string;
        kind?: 'agent' | 'automation' | 'form' | 'app' | 'datatable' | 'kb' | 'skill' | 'webpage' | 'document' | 'meeting' | 'playbook' | 'solution' | 'cowork';
        limit?: number;
        orgId?: string;
        reveal?: 'true' | 'false';
        startDate?: string;
    }>;
    'GET /api/usage/adoption/studio': Op<NoParams, {
        cursor?: number;
        days?: number;
        endDate?: string;
        group?: string;
        kind?: 'agent' | 'automation' | 'form' | 'app' | 'datatable' | 'kb' | 'skill' | 'webpage' | 'document' | 'meeting' | 'playbook' | 'solution' | 'cowork';
        limit?: number;
        orgId?: string;
        reveal?: 'true' | 'false';
        startDate?: string;
    }>;
    'GET /api/usage/adoption/studio/items': Op<NoParams, {
        cursor?: number;
        days?: number;
        endDate?: string;
        group?: string;
        kind?: 'agent' | 'automation' | 'form' | 'app' | 'datatable' | 'kb' | 'skill' | 'webpage' | 'document' | 'meeting' | 'playbook' | 'solution' | 'cowork';
        limit?: number;
        orgId?: string;
        reveal?: 'true' | 'false';
        startDate?: string;
    }>;
    'GET /api/usage/adoption/summary': Op<NoParams, {
        cursor?: number;
        days?: number;
        endDate?: string;
        group?: string;
        kind?: 'agent' | 'automation' | 'form' | 'app' | 'datatable' | 'kb' | 'skill' | 'webpage' | 'document' | 'meeting' | 'playbook' | 'solution' | 'cowork';
        limit?: number;
        orgId?: string;
        reveal?: 'true' | 'false';
        startDate?: string;
    }>;
    'GET /api/usage/agents': Op<NoParams, {
        agent?: string;
        cursor?: number;
        days?: number;
        dimension?: 'user' | 'integration' | 'agent' | 'pii';
        endDate?: string;
        eu?: 'true' | 'false';
        integration?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        local?: 'true' | 'false';
        model?: string;
        orgId?: string;
        pii?: string;
        source?: string;
        startDate?: string;
        type?: string;
        user?: string;
    }>;
    'GET /api/usage/azure-services/by-type': Op<NoParams, {
        agent?: string;
        cursor?: number;
        days?: number;
        dimension?: 'user' | 'integration' | 'agent' | 'pii';
        endDate?: string;
        eu?: 'true' | 'false';
        integration?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        local?: 'true' | 'false';
        model?: string;
        orgId?: string;
        pii?: string;
        source?: string;
        startDate?: string;
        type?: string;
        user?: string;
    }>;
    'GET /api/usage/azure-services/by-user': Op<NoParams, {
        agent?: string;
        cursor?: number;
        days?: number;
        dimension?: 'user' | 'integration' | 'agent' | 'pii';
        endDate?: string;
        eu?: 'true' | 'false';
        integration?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        local?: 'true' | 'false';
        model?: string;
        orgId?: string;
        pii?: string;
        source?: string;
        startDate?: string;
        type?: string;
        user?: string;
    }>;
    'GET /api/usage/azure-services/rates': Op<NoParams, {
        agent?: string;
        cursor?: number;
        days?: number;
        dimension?: 'user' | 'integration' | 'agent' | 'pii';
        endDate?: string;
        eu?: 'true' | 'false';
        integration?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        local?: 'true' | 'false';
        model?: string;
        orgId?: string;
        pii?: string;
        source?: string;
        startDate?: string;
        type?: string;
        user?: string;
    }>;
    'GET /api/usage/azure-services/recent': Op<NoParams, {
        agent?: string;
        cursor?: number;
        days?: number;
        dimension?: 'user' | 'integration' | 'agent' | 'pii';
        endDate?: string;
        eu?: 'true' | 'false';
        integration?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        local?: 'true' | 'false';
        model?: string;
        orgId?: string;
        pii?: string;
        source?: string;
        startDate?: string;
        type?: string;
        user?: string;
    }>;
    'GET /api/usage/azure-services/summary': Op<NoParams, {
        agent?: string;
        cursor?: number;
        days?: number;
        dimension?: 'user' | 'integration' | 'agent' | 'pii';
        endDate?: string;
        eu?: 'true' | 'false';
        integration?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        local?: 'true' | 'false';
        model?: string;
        orgId?: string;
        pii?: string;
        source?: string;
        startDate?: string;
        type?: string;
        user?: string;
    }>;
    'GET /api/usage/azure-services/timeline': Op<NoParams, {
        agent?: string;
        cursor?: number;
        days?: number;
        dimension?: 'user' | 'integration' | 'agent' | 'pii';
        endDate?: string;
        eu?: 'true' | 'false';
        integration?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        local?: 'true' | 'false';
        model?: string;
        orgId?: string;
        pii?: string;
        source?: string;
        startDate?: string;
        type?: string;
        user?: string;
    }>;
    'GET /api/usage/by-agent': Op<NoParams, {
        agent?: string;
        cursor?: number;
        days?: number;
        dimension?: 'user' | 'integration' | 'agent' | 'pii';
        endDate?: string;
        eu?: 'true' | 'false';
        integration?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        local?: 'true' | 'false';
        model?: string;
        orgId?: string;
        pii?: string;
        source?: string;
        startDate?: string;
        type?: string;
        user?: string;
    }>;
    'GET /api/usage/by-conversation': Op<NoParams, {
        agent?: string;
        cursor?: number;
        days?: number;
        dimension?: 'user' | 'integration' | 'agent' | 'pii';
        endDate?: string;
        eu?: 'true' | 'false';
        integration?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        local?: 'true' | 'false';
        model?: string;
        orgId?: string;
        pii?: string;
        source?: string;
        startDate?: string;
        type?: string;
        user?: string;
    }>;
    'GET /api/usage/by-model': Op<NoParams, {
        agent?: string;
        cursor?: number;
        days?: number;
        dimension?: 'user' | 'integration' | 'agent' | 'pii';
        endDate?: string;
        eu?: 'true' | 'false';
        integration?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        local?: 'true' | 'false';
        model?: string;
        orgId?: string;
        pii?: string;
        source?: string;
        startDate?: string;
        type?: string;
        user?: string;
    }>;
    'GET /api/usage/by-swarm-run': Op<NoParams, {
        agent?: string;
        cursor?: number;
        days?: number;
        dimension?: 'user' | 'integration' | 'agent' | 'pii';
        endDate?: string;
        eu?: 'true' | 'false';
        integration?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        local?: 'true' | 'false';
        model?: string;
        orgId?: string;
        pii?: string;
        source?: string;
        startDate?: string;
        type?: string;
        user?: string;
    }>;
    'GET /api/usage/by-user': Op<NoParams, {
        agent?: string;
        cursor?: number;
        days?: number;
        dimension?: 'user' | 'integration' | 'agent' | 'pii';
        endDate?: string;
        eu?: 'true' | 'false';
        integration?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        local?: 'true' | 'false';
        model?: string;
        orgId?: string;
        pii?: string;
        source?: string;
        startDate?: string;
        type?: string;
        user?: string;
    }>;
    'GET /api/usage/cost-timeline': Op<NoParams, {
        agent?: string;
        cursor?: number;
        days?: number;
        dimension?: 'user' | 'integration' | 'agent' | 'pii';
        endDate?: string;
        eu?: 'true' | 'false';
        integration?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        local?: 'true' | 'false';
        model?: string;
        orgId?: string;
        pii?: string;
        source?: string;
        startDate?: string;
        type?: string;
        user?: string;
    }>;
    'GET /api/usage/filters/models': Op<NoParams, {
        agent?: string;
        cursor?: number;
        days?: number;
        dimension?: 'user' | 'integration' | 'agent' | 'pii';
        endDate?: string;
        eu?: 'true' | 'false';
        integration?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        local?: 'true' | 'false';
        model?: string;
        orgId?: string;
        pii?: string;
        source?: string;
        startDate?: string;
        type?: string;
        user?: string;
    }>;
    'GET /api/usage/filters/sources': Op<NoParams, {
        agent?: string;
        cursor?: number;
        days?: number;
        dimension?: 'user' | 'integration' | 'agent' | 'pii';
        endDate?: string;
        eu?: 'true' | 'false';
        integration?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        local?: 'true' | 'false';
        model?: string;
        orgId?: string;
        pii?: string;
        source?: string;
        startDate?: string;
        type?: string;
        user?: string;
    }>;
    'GET /api/usage/guardrails/by-action': Op<NoParams, {
        agent?: string;
        cursor?: number;
        days?: number;
        dimension?: 'user' | 'integration' | 'agent' | 'pii';
        endDate?: string;
        eu?: 'true' | 'false';
        integration?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        local?: 'true' | 'false';
        model?: string;
        orgId?: string;
        pii?: string;
        source?: string;
        startDate?: string;
        type?: string;
        user?: string;
    }>;
    'GET /api/usage/guardrails/by-category': Op<NoParams, {
        agent?: string;
        cursor?: number;
        days?: number;
        dimension?: 'user' | 'integration' | 'agent' | 'pii';
        endDate?: string;
        eu?: 'true' | 'false';
        integration?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        local?: 'true' | 'false';
        model?: string;
        orgId?: string;
        pii?: string;
        source?: string;
        startDate?: string;
        type?: string;
        user?: string;
    }>;
    'GET /api/usage/guardrails/by-user': Op<NoParams, {
        agent?: string;
        cursor?: number;
        days?: number;
        dimension?: 'user' | 'integration' | 'agent' | 'pii';
        endDate?: string;
        eu?: 'true' | 'false';
        integration?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        local?: 'true' | 'false';
        model?: string;
        orgId?: string;
        pii?: string;
        source?: string;
        startDate?: string;
        type?: string;
        user?: string;
    }>;
    'GET /api/usage/guardrails/overview': Op<NoParams, {
        agent?: string;
        cursor?: number;
        days?: number;
        dimension?: 'user' | 'integration' | 'agent' | 'pii';
        endDate?: string;
        eu?: 'true' | 'false';
        integration?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        local?: 'true' | 'false';
        model?: string;
        orgId?: string;
        pii?: string;
        source?: string;
        startDate?: string;
        type?: string;
        user?: string;
    }>;
    'GET /api/usage/guardrails/recent': Op<NoParams, {
        agent?: string;
        cursor?: number;
        days?: number;
        dimension?: 'user' | 'integration' | 'agent' | 'pii';
        endDate?: string;
        eu?: 'true' | 'false';
        integration?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        local?: 'true' | 'false';
        model?: string;
        orgId?: string;
        pii?: string;
        source?: string;
        startDate?: string;
        type?: string;
        user?: string;
    }>;
    'GET /api/usage/guardrails/summary': Op<NoParams, {
        agent?: string;
        cursor?: number;
        days?: number;
        dimension?: 'user' | 'integration' | 'agent' | 'pii';
        endDate?: string;
        eu?: 'true' | 'false';
        integration?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        local?: 'true' | 'false';
        model?: string;
        orgId?: string;
        pii?: string;
        source?: string;
        startDate?: string;
        type?: string;
        user?: string;
    }>;
    'GET /api/usage/guardrails/timeline': Op<NoParams, {
        agent?: string;
        cursor?: number;
        days?: number;
        dimension?: 'user' | 'integration' | 'agent' | 'pii';
        endDate?: string;
        eu?: 'true' | 'false';
        integration?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        local?: 'true' | 'false';
        model?: string;
        orgId?: string;
        pii?: string;
        source?: string;
        startDate?: string;
        type?: string;
        user?: string;
    }>;
    'GET /api/usage/integrations-health': Op<NoParams, {
        agent?: string;
        cursor?: number;
        days?: number;
        dimension?: 'user' | 'integration' | 'agent' | 'pii';
        endDate?: string;
        eu?: 'true' | 'false';
        integration?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        local?: 'true' | 'false';
        model?: string;
        orgId?: string;
        pii?: string;
        source?: string;
        startDate?: string;
        type?: string;
        user?: string;
    }>;
    'GET /api/usage/integrations/by-tool': Op<NoParams, {
        agent?: string;
        cursor?: number;
        days?: number;
        dimension?: 'user' | 'integration' | 'agent' | 'pii';
        endDate?: string;
        eu?: 'true' | 'false';
        integration?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        local?: 'true' | 'false';
        model?: string;
        orgId?: string;
        pii?: string;
        source?: string;
        startDate?: string;
        type?: string;
        user?: string;
    }>;
    'GET /api/usage/integrations/by-type': Op<NoParams, {
        agent?: string;
        cursor?: number;
        days?: number;
        dimension?: 'user' | 'integration' | 'agent' | 'pii';
        endDate?: string;
        eu?: 'true' | 'false';
        integration?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        local?: 'true' | 'false';
        model?: string;
        orgId?: string;
        pii?: string;
        source?: string;
        startDate?: string;
        type?: string;
        user?: string;
    }>;
    'GET /api/usage/integrations/egress': Op<NoParams, {
        agent?: string;
        cursor?: number;
        days?: number;
        dimension?: 'user' | 'integration' | 'agent' | 'pii';
        endDate?: string;
        eu?: 'true' | 'false';
        integration?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        local?: 'true' | 'false';
        model?: string;
        orgId?: string;
        pii?: string;
        source?: string;
        startDate?: string;
        type?: string;
        user?: string;
    }>;
    'GET /api/usage/integrations/operator-summary': Op<NoParams, {
        agent?: string;
        cursor?: number;
        days?: number;
        dimension?: 'user' | 'integration' | 'agent' | 'pii';
        endDate?: string;
        eu?: 'true' | 'false';
        integration?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        local?: 'true' | 'false';
        model?: string;
        orgId?: string;
        pii?: string;
        source?: string;
        startDate?: string;
        type?: string;
        user?: string;
    }>;
    'GET /api/usage/integrations/overview': Op<NoParams, {
        agent?: string;
        cursor?: number;
        days?: number;
        dimension?: 'user' | 'integration' | 'agent' | 'pii';
        endDate?: string;
        eu?: 'true' | 'false';
        integration?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        local?: 'true' | 'false';
        model?: string;
        orgId?: string;
        pii?: string;
        source?: string;
        startDate?: string;
        type?: string;
        user?: string;
    }>;
    'GET /api/usage/integrations/pii-summary': Op<NoParams, {
        agent?: string;
        cursor?: number;
        days?: number;
        dimension?: 'user' | 'integration' | 'agent' | 'pii';
        endDate?: string;
        eu?: 'true' | 'false';
        integration?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        local?: 'true' | 'false';
        model?: string;
        orgId?: string;
        pii?: string;
        source?: string;
        startDate?: string;
        type?: string;
        user?: string;
    }>;
    'GET /api/usage/integrations/recent': Op<NoParams, {
        agent?: string;
        cursor?: number;
        days?: number;
        dimension?: 'user' | 'integration' | 'agent' | 'pii';
        endDate?: string;
        eu?: 'true' | 'false';
        integration?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        local?: 'true' | 'false';
        model?: string;
        orgId?: string;
        pii?: string;
        source?: string;
        startDate?: string;
        type?: string;
        user?: string;
    }>;
    'GET /api/usage/integrations/servers': Op<NoParams, {
        agent?: string;
        cursor?: number;
        days?: number;
        dimension?: 'user' | 'integration' | 'agent' | 'pii';
        endDate?: string;
        eu?: 'true' | 'false';
        integration?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        local?: 'true' | 'false';
        model?: string;
        orgId?: string;
        pii?: string;
        source?: string;
        startDate?: string;
        type?: string;
        user?: string;
    }>;
    'GET /api/usage/integrations/sovereignty': Op<NoParams, {
        agent?: string;
        cursor?: number;
        days?: number;
        dimension?: 'user' | 'integration' | 'agent' | 'pii';
        endDate?: string;
        eu?: 'true' | 'false';
        integration?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        local?: 'true' | 'false';
        model?: string;
        orgId?: string;
        pii?: string;
        source?: string;
        startDate?: string;
        type?: string;
        user?: string;
    }>;
    'GET /api/usage/integrations/summary': Op<NoParams, {
        agent?: string;
        cursor?: number;
        days?: number;
        dimension?: 'user' | 'integration' | 'agent' | 'pii';
        endDate?: string;
        eu?: 'true' | 'false';
        integration?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        local?: 'true' | 'false';
        model?: string;
        orgId?: string;
        pii?: string;
        source?: string;
        startDate?: string;
        type?: string;
        user?: string;
    }>;
    'GET /api/usage/integrations/timeline': Op<NoParams, {
        agent?: string;
        cursor?: number;
        days?: number;
        dimension?: 'user' | 'integration' | 'agent' | 'pii';
        endDate?: string;
        eu?: 'true' | 'false';
        integration?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        local?: 'true' | 'false';
        model?: string;
        orgId?: string;
        pii?: string;
        source?: string;
        startDate?: string;
        type?: string;
        user?: string;
    }>;
    'GET /api/usage/models': Op<NoParams, {
        agent?: string;
        cursor?: number;
        days?: number;
        dimension?: 'user' | 'integration' | 'agent' | 'pii';
        endDate?: string;
        eu?: 'true' | 'false';
        integration?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        local?: 'true' | 'false';
        model?: string;
        orgId?: string;
        pii?: string;
        source?: string;
        startDate?: string;
        type?: string;
        user?: string;
    }>;
    'GET /api/usage/models-by-agent': Op<NoParams, {
        agent?: string;
        cursor?: number;
        days?: number;
        dimension?: 'user' | 'integration' | 'agent' | 'pii';
        endDate?: string;
        eu?: 'true' | 'false';
        integration?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        local?: 'true' | 'false';
        model?: string;
        orgId?: string;
        pii?: string;
        source?: string;
        startDate?: string;
        type?: string;
        user?: string;
    }>;
    'GET /api/usage/models-by-user': Op<NoParams, {
        agent?: string;
        cursor?: number;
        days?: number;
        dimension?: 'user' | 'integration' | 'agent' | 'pii';
        endDate?: string;
        eu?: 'true' | 'false';
        integration?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        local?: 'true' | 'false';
        model?: string;
        orgId?: string;
        pii?: string;
        source?: string;
        startDate?: string;
        type?: string;
        user?: string;
    }>;
    'GET /api/usage/organizations': Op<NoParams, {
        agent?: string;
        cursor?: number;
        days?: number;
        dimension?: 'user' | 'integration' | 'agent' | 'pii';
        endDate?: string;
        eu?: 'true' | 'false';
        integration?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        local?: 'true' | 'false';
        model?: string;
        orgId?: string;
        pii?: string;
        source?: string;
        startDate?: string;
        type?: string;
        user?: string;
    }>;
    'GET /api/usage/prompt-cache': Op<NoParams, {
        agent?: string;
        cursor?: number;
        days?: number;
        dimension?: 'user' | 'integration' | 'agent' | 'pii';
        endDate?: string;
        eu?: 'true' | 'false';
        integration?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        local?: 'true' | 'false';
        model?: string;
        orgId?: string;
        pii?: string;
        source?: string;
        startDate?: string;
        type?: string;
        user?: string;
    }>;
    'GET /api/usage/recent': Op<NoParams, {
        agent?: string;
        cursor?: number;
        days?: number;
        dimension?: 'user' | 'integration' | 'agent' | 'pii';
        endDate?: string;
        eu?: 'true' | 'false';
        integration?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        local?: 'true' | 'false';
        model?: string;
        orgId?: string;
        pii?: string;
        source?: string;
        startDate?: string;
        type?: string;
        user?: string;
    }>;
    'GET /api/usage/sources': Op<NoParams, {
        agent?: string;
        cursor?: number;
        days?: number;
        dimension?: 'user' | 'integration' | 'agent' | 'pii';
        endDate?: string;
        eu?: 'true' | 'false';
        integration?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        local?: 'true' | 'false';
        model?: string;
        orgId?: string;
        pii?: string;
        source?: string;
        startDate?: string;
        type?: string;
        user?: string;
    }>;
    'GET /api/usage/summary': Op<NoParams, {
        agent?: string;
        cursor?: number;
        days?: number;
        dimension?: 'user' | 'integration' | 'agent' | 'pii';
        endDate?: string;
        eu?: 'true' | 'false';
        integration?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        local?: 'true' | 'false';
        model?: string;
        orgId?: string;
        pii?: string;
        source?: string;
        startDate?: string;
        type?: string;
        user?: string;
    }>;
    'GET /api/usage/timeline': Op<NoParams, {
        agent?: string;
        cursor?: number;
        days?: number;
        dimension?: 'user' | 'integration' | 'agent' | 'pii';
        endDate?: string;
        eu?: 'true' | 'false';
        integration?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        local?: 'true' | 'false';
        model?: string;
        orgId?: string;
        pii?: string;
        source?: string;
        startDate?: string;
        type?: string;
        user?: string;
    }>;
    'GET /api/usage/tools': Op<NoParams, {
        agent?: string;
        cursor?: number;
        days?: number;
        dimension?: 'user' | 'integration' | 'agent' | 'pii';
        endDate?: string;
        eu?: 'true' | 'false';
        integration?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        local?: 'true' | 'false';
        model?: string;
        orgId?: string;
        pii?: string;
        source?: string;
        startDate?: string;
        type?: string;
        user?: string;
    }>;
    'GET /api/usage/users': Op<NoParams, {
        agent?: string;
        cursor?: number;
        days?: number;
        dimension?: 'user' | 'integration' | 'agent' | 'pii';
        endDate?: string;
        eu?: 'true' | 'false';
        integration?: string;
        interval?: 'hour' | 'day';
        limit?: number;
        local?: 'true' | 'false';
        model?: string;
        orgId?: string;
        pii?: string;
        source?: string;
        startDate?: string;
        type?: string;
        user?: string;
    }>;
    'GET /api/voiceprints/availability': Op;
    'GET /api/voiceprints/me': Op;
    'POST /api/voiceprints/me': Op<NoParams, UndeclaredQuery, {
        consent?: string;
        duration_seconds?: string;
        language?: string;
    }>;
    'DELETE /api/voiceprints/me': Op<NoParams, UndeclaredQuery, Record<string, never>>;
    'GET /api/voiceprints/org/{orgId}/coverage': Op<{ orgId: string | number }>;
    'DELETE /api/voiceprints/org/{orgId}/user/{userId}': Op<{ orgId: string | number; userId: string | number }>;
    'POST /api/web-vitals': Op;
    'GET /api/webpages': Op;
    'POST /api/webpages': Op<NoParams, UndeclaredQuery, {
        description?: string;
        framework?: 'vanilla' | 'react-mui';
        instructions?: string;
        name?: string;
        prompt?: string;
        runtime?: 'light' | 'full';
        sources?: Array<unknown>;
    }>;
    'POST /api/webpages-preview/{id}/ai/ask': Op<{ id: string | number }>;
    'POST /api/webpages-preview/{id}/ai/chat': Op<{ id: string | number }>;
    'POST /api/webpages-preview/{id}/ai/stream': Op<{ id: string | number }>;
    'GET /api/webpages-preview/{id}/automations': Op<{ id: string | number }>;
    'GET /api/webpages-preview/{id}/automations/runs/{runId}': Op<{ id: string | number; runId: string | number }>;
    'POST /api/webpages-preview/{id}/automations/runs/{runId}/cancel': Op<{ id: string | number; runId: string | number }>;
    'GET /api/webpages-preview/{id}/automations/runs/{runId}/steps': Op<{ id: string | number; runId: string | number }>;
    'POST /api/webpages-preview/{id}/automations/{autoId}/run': Op<{ id: string | number; autoId: string | number }>;
    'POST /api/webpages-preview/{id}/db/batch': Op<{ id: string | number }>;
    'POST /api/webpages-preview/{id}/db/exec': Op<{ id: string | number }>;
    'POST /api/webpages-preview/{id}/db/query': Op<{ id: string | number }>;
    'GET /api/webpages-preview/{id}/db/schema': Op<{ id: string | number }>;
    'GET /api/webpages-preview/{id}/integrations': Op<{ id: string | number }>;
    'POST /api/webpages-preview/{id}/integrations/run': Op<{ id: string | number }>;
    'POST /api/webpages-preview/{id}/tables/{tid}/insert': Op<{ id: string | number; tid: string | number }, UndeclaredQuery, {
        values?: unknown;
    }>;
    'POST /api/webpages-preview/{id}/tables/{tid}/query': Op<{ id: string | number; tid: string | number }, UndeclaredQuery, {
        cursor?: string | null;
        filters?: Array<Record<string, unknown>> | null;
        limit?: number | null;
        match?: 'all' | 'any' | null;
        sort?: {
            dir?: string;
            direction?: string;
            field: string;
        } | Array<{
            dir?: string;
            direction?: string;
            field: string;
        }> | null;
    }>;
    'POST /api/webpages-preview/{id}/tables/{tid}/update': Op<{ id: string | number; tid: string | number }, UndeclaredQuery, {
        expectedUpdatedAt?: unknown;
        rowId?: unknown;
        values?: unknown;
    }>;
    'GET /api/webpages/{id}': Op<{ id: string | number }>;
    'PUT /api/webpages/{id}': Op<{ id: string | number }, UndeclaredQuery, {
        css?: string;
        description?: string | null;
        html?: string;
        instructions?: string | null;
        js?: string;
        knowledgeBaseIds?: Array<string>;
        name?: string;
        settings?: Record<string, unknown>;
    }>;
    'DELETE /api/webpages/{id}': Op<{ id: string | number }, {
        confirm?: '0' | '1' | 'true' | 'false';
    }, Record<string, never>>;
    'POST /api/webpages/{id}/assets': Op<{ id: string | number }, UndeclaredQuery, {
        path: string;
    }>;
    'POST /api/webpages/{id}/assets/move': Op<{ id: string | number }, UndeclaredQuery, {
        from: string;
        to: string;
    }>;
    'GET /api/webpages/{id}/audience': Op<{ id: string | number }>;
    'PUT /api/webpages/{id}/audience/public': Op<{ id: string | number }, UndeclaredQuery, {
        accessMode?: 'unlisted' | 'password' | 'email';
        allowedEmails?: Array<string>;
        expiresAt?: string | number | null;
        on: boolean;
        password?: string;
        publicColumns?: Record<string, Array<string>>;
    }>;
    'GET /api/webpages/{id}/bindings': Op<{ id: string | number }>;
    'PUT /api/webpages/{id}/chat': Op<{ id: string | number }, UndeclaredQuery, {
        messages: Array<unknown>;
    }>;
    'DELETE /api/webpages/{id}/chat': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/webpages/{id}/clone': Op<{ id: string | number }, UndeclaredQuery, {
        name?: string;
    }>;
    'GET /api/webpages/{id}/data-cards': Op<{ id: string | number }>;
    'DELETE /api/webpages/{id}/db': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/webpages/{id}/db/exec': Op<{ id: string | number }, UndeclaredQuery, {
        params?: Array<unknown>;
        sql: string;
    }>;
    'POST /api/webpages/{id}/db/query': Op<{ id: string | number }, UndeclaredQuery, {
        params?: Array<unknown>;
        sql: string;
    }>;
    'GET /api/webpages/{id}/db/schema': Op<{ id: string | number }>;
    'GET /api/webpages/{id}/draft-document': Op<{ id: string | number }>;
    'POST /api/webpages/{id}/export/pdf': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/webpages/{id}/files': Op<{ id: string | number }, {
        path?: string;
    }>;
    'PUT /api/webpages/{id}/files': Op<{ id: string | number }, UndeclaredQuery, {
        content: string;
        path: string;
    }>;
    'DELETE /api/webpages/{id}/files': Op<{ id: string | number }, {
        path: string;
    }>;
    'GET /api/webpages/{id}/grants': Op<{ id: string | number }>;
    'POST /api/webpages/{id}/grants/automations': Op<{ id: string | number }, UndeclaredQuery, {
        automationId: string;
        label?: string;
    }>;
    'DELETE /api/webpages/{id}/grants/automations/{automationId}': Op<{ id: string | number; automationId: string | number }>;
    'PUT /api/webpages/{id}/grants/db': Op<{ id: string | number }, UndeclaredQuery, {
        viewersMayWrite: boolean;
    }>;
    'POST /api/webpages/{id}/grants/integrations': Op<{ id: string | number }, UndeclaredQuery, {
        fixedArgs?: Record<string, unknown>;
        label?: string;
        tool: string;
    }>;
    'DELETE /api/webpages/{id}/grants/integrations/{tool}': Op<{ id: string | number; tool: string | number }>;
    'POST /api/webpages/{id}/preview-token': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/webpages/{id}/public-shares': Op<{ id: string | number }>;
    'POST /api/webpages/{id}/public-shares': Op<{ id: string | number }, UndeclaredQuery, {
        accessMode: 'unlisted' | 'password' | 'email';
        allowedEmails?: Array<string>;
        expiresAt?: string | number | null;
        password?: string;
        title?: string;
    }>;
    'PATCH /api/webpages/{id}/public-shares/{shareId}': Op<{ id: string | number; shareId: string | number }, UndeclaredQuery, {
        expiresAt: string | number | null;
    }>;
    'DELETE /api/webpages/{id}/public-shares/{shareId}': Op<{ id: string | number; shareId: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/webpages/{id}/public-shares/{shareId}/refresh': Op<{ id: string | number; shareId: string | number }, UndeclaredQuery, Record<string, never>>;
    'PATCH /api/webpages/{id}/publish': Op<{ id: string | number }, UndeclaredQuery, {
        isPublished: boolean;
        republish?: boolean;
        sharedGroups?: Array<string>;
    }>;
    'GET /api/webpages/{id}/sources': Op<{ id: string | number }>;
    'POST /api/webpages/{id}/sources/drive': Op<{ id: string | number }, UndeclaredQuery, {
        files: Array<unknown>;
        provider: 'google' | 'microsoft';
    }>;
    'POST /api/webpages/{id}/sources/file': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/webpages/{id}/sources/text': Op<{ id: string | number }, UndeclaredQuery, {
        name?: string;
        text: string;
    }>;
    'POST /api/webpages/{id}/sources/url': Op<{ id: string | number }, UndeclaredQuery, {
        url: string;
    }>;
    'DELETE /api/webpages/{id}/sources/{sid}': Op<{ id: string | number; sid: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/webpages/{id}/sources/{sid}/cancel': Op<{ id: string | number; sid: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/webpages/{id}/sources/{sid}/retry': Op<{ id: string | number; sid: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /api/webpages/{id}/thumbnail': Op<{ id: string | number }, {
        v?: string;
    }>;
    'GET /api/webpages/{id}/usage': Op<{ id: string | number }>;
    'GET /api/webpages/{id}/versions': Op<{ id: string | number }, {
        limit?: number;
        offset?: number;
    }>;
    'POST /api/webpages/{id}/versions': Op<{ id: string | number }, UndeclaredQuery, {
        summary?: string;
    }>;
    'GET /api/webpages/{id}/versions/{vid}': Op<{ id: string | number; vid: string | number }>;
    'DELETE /api/webpages/{id}/versions/{vid}': Op<{ id: string | number; vid: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /api/webpages/{id}/versions/{vid}/restore': Op<{ id: string | number; vid: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /apps': Op;
    'POST /apps': Op<NoParams, UndeclaredQuery, {
        code: string;
        description?: string | null;
        isPublished?: boolean;
        name: string;
        sharedGroups?: Array<string>;
        thumbnail?: string | null;
    }>;
    'GET /apps/mine': Op;
    'GET /apps/{id}': Op<{ id: string | number }>;
    'PUT /apps/{id}': Op<{ id: string | number }, UndeclaredQuery, {
        code?: string;
        description?: string | null;
        isPublished?: boolean;
        name?: string;
        sharedGroups?: Array<string>;
        thumbnail?: string | null;
    }>;
    'DELETE /apps/{id}': Op<{ id: string | number }>;
    'POST /auth/admin-login': Op<NoParams, UndeclaredQuery, {
        password: string;
        username: string;
    }>;
    'GET /auth/admin/connector-health/fleet': Op;
    'GET /auth/admin/connector-health/mine': Op;
    'GET /auth/admin/connector-health/{orgId}/events': Op<{ orgId: string | number }, {
        code?: string;
        cursor?: string;
        limit?: number;
        severity?: 'info' | 'warning' | 'error' | 'critical';
    }>;
    'GET /auth/admin/connector-health/{orgId}/problems': Op<{ orgId: string | number }, {
        includeResolved?: '0' | '1' | 'true' | 'false';
    }>;
    'GET /auth/admin/connector/tenants/{orgId}/key': Op<{ orgId: string | number }>;
    'POST /auth/admin/connector/tenants/{orgId}/key': Op<{ orgId: string | number }, UndeclaredQuery, Record<string, never>>;
    'DELETE /auth/admin/connector/tenants/{orgId}/key': Op<{ orgId: string | number }>;
    'POST /auth/admin/nc-bindings/generate-pairing-code': Op<NoParams, UndeclaredQuery, {
        organizationId?: string;
    }>;
    'DELETE /auth/admin/nc-bindings/org/{orgId}': Op<{ orgId: string | number }>;
    'GET /auth/admin/nc-bindings/pairing-codes': Op;
    'DELETE /auth/admin/nc-bindings/pairing-codes/{id}': Op<{ id: string | number }>;
    'GET /auth/admin/nc-bindings/pending': Op;
    'POST /auth/admin/nc-bindings/{id}/approve': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /auth/admin/nc-bindings/{id}/deny': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'PUT /auth/admin/selected-org': Op<NoParams, UndeclaredQuery, {
        orgId?: string | null;
    }>;
    'GET /auth/admin/signup-settings': Op;
    'PUT /auth/admin/signup-settings': Op<NoParams, UndeclaredQuery, {
        allowConsumerSignups?: boolean;
        allowOrgSignups?: boolean;
        connectorOnly?: boolean;
        consumerLoginMethods?: Array<'password' | 'google' | 'microsoft'>;
        emailVerificationEnabled?: boolean;
        geoApplyConnector?: boolean;
        geoBlockUnknown?: boolean;
        geoCountries?: Array<string>;
        geoMode?: 'off' | 'allowlist' | 'blocklist';
        orgDirectoryPublic?: boolean;
        requireMfaForPasswordAccounts?: boolean;
        waitlistEnabled?: boolean;
    }>;
    'GET /auth/admin/waitlist': Op;
    'POST /auth/admin/waitlist/{userId}/approve': Op<{ userId: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /auth/admin/waitlist/{userId}/reject': Op<{ userId: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /auth/admin/{orgId}/nc-integrations': Op<{ orgId: string | number }>;
    'PUT /auth/admin/{orgId}/nc-integrations': Op<{ orgId: string | number }, UndeclaredQuery, {
        enabled: Array<string>;
    }>;
    'GET /auth/admin/{orgId}/nc-integrations/groups': Op<{ orgId: string | number }>;
    'PUT /auth/admin/{orgId}/nc-integrations/groups/{groupId}': Op<{ orgId: string | number; groupId: string | number }, UndeclaredQuery, {
        disabledIntegrations: Array<string>;
    }>;
    'POST /auth/admin/{orgId}/nc-onboarding/complete': Op<{ orgId: string | number }, UndeclaredQuery, {
        deploymentMode?: 'cloud' | 'self-hosted';
        excludedGroups?: Array<string>;
        newUserDefaultStatus: 'active' | 'pending';
        privacyShield?: {
            enabled?: boolean;
            piiDetectionAction?: 'tokenize' | 'block';
            piiDetectionCategories?: Array<string>;
        };
        selectedPlanId?: string | null;
        syncGroups?: Array<string>;
        syncMode: 'mirror_all' | 'selective_groups' | 'manual';
    }>;
    'GET /auth/admin/{orgId}/nc-sync': Op<{ orgId: string | number }>;
    'PUT /auth/admin/{orgId}/nc-sync': Op<{ orgId: string | number }, UndeclaredQuery, {
        excludedGroups?: Array<string>;
        mode?: 'mirror_all' | 'selective_groups' | 'manual';
        newUserDefaultStatus?: 'active' | 'pending';
        syncGroups?: Array<string>;
    }>;
    'GET /auth/admin/{orgId}/nc-sync/groups': Op<{ orgId: string | number }>;
    'POST /auth/admin/{orgId}/nc-sync/run': Op<{ orgId: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /auth/admin/{orgId}/nc-sync/users': Op<{ orgId: string | number }>;
    'DELETE /auth/app-password': Op;
    'GET /auth/app-password-status': Op;
    'GET /auth/beta-features': Op;
    'GET /auth/callback': Op;
    'GET /auth/callback/{provider}': Op<{ provider: string | number }>;
    'POST /auth/change-password': Op<NoParams, UndeclaredQuery, {
        newPassword: string;
        oldPassword: string;
    }>;
    'GET /auth/connector-provisioning-mode': Op;
    'PUT /auth/connector-provisioning-mode': Op<NoParams, UndeclaredQuery, {
        mode: 'open' | 'pairing_only' | null;
    }>;
    'POST /auth/connector/bootstrap': Op<NoParams, UndeclaredQuery, {
        ncAdmins?: unknown;
        themingName?: unknown;
        version?: unknown;
    }>;
    'GET /auth/connector/bootstrap/pending/{id}': Op<{ id: string | number }>;
    'POST /auth/connector/bootstrap/pending/{id}/resend': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /auth/connector/bootstrap/pending/{id}/retarget': Op<{ id: string | number }, UndeclaredQuery, {
        displayName?: unknown;
        email?: unknown;
        uid?: unknown;
    }>;
    'POST /auth/connector/bootstrap/pending/{id}/verify': Op<{ id: string | number }, UndeclaredQuery, {
        code?: unknown;
    }>;
    'POST /auth/connector/diagnose': Op<NoParams, UndeclaredQuery, {
        testToken?: unknown;
    }>;
    'POST /auth/connector/link': Op<NoParams, UndeclaredQuery, {
        ticket: string;
    }>;
    'POST /auth/connector/rotate-key': Op;
    'POST /auth/connector/status': Op;
    'GET /auth/consents': Op;
    'POST /auth/consents/optional': Op<NoParams, UndeclaredQuery, {
        granted: boolean;
        id: string;
    }>;
    'POST /auth/create-app-password': Op<NoParams, UndeclaredQuery, Record<string, never>>;
    'GET /auth/default-integrations': Op;
    'PUT /auth/default-integrations': Op<NoParams, UndeclaredQuery, {
        defaults: Array<string> | null;
    }>;
    'POST /auth/forgot-password': Op<NoParams, UndeclaredQuery, {
        email: string;
    }>;
    'GET /auth/free-email-domains': Op;
    'PUT /auth/free-email-domains': Op<NoParams, UndeclaredQuery, {
        extra: Array<unknown>;
    }>;
    'GET /auth/groups': Op;
    'POST /auth/groups': Op<NoParams, UndeclaredQuery, {
        allowedAgentTypes?: unknown;
        description?: string;
        name: string;
        organizationId?: string | null;
        perUserCostLimit?: number | null;
        perUserImageLimits?: {
            day?: number | null;
            hour?: number | null;
            month?: number | null;
            week?: number | null;
        } | null;
        permissions?: unknown;
        roles?: unknown;
    }>;
    'PUT /auth/groups/{id}': Op<{ id: string | number }, UndeclaredQuery, {
        allowedAgentTypes?: unknown;
        allowedTiers?: unknown;
        description?: string;
        orgRole?: string | null;
        organizationId?: string | null;
        perUserCostLimit?: number | null;
        perUserImageLimits?: {
            day?: number | null;
            hour?: number | null;
            month?: number | null;
            week?: number | null;
        } | null;
        permissions?: unknown;
        roles?: unknown;
    }>;
    'DELETE /auth/groups/{id}': Op<{ id: string | number }>;
    'PUT /auth/groups/{id}/access': Op<{ id: string | number }, UndeclaredQuery, {
        granted: Array<string>;
    }>;
    'POST /auth/groups/{id}/members': Op<{ id: string | number }, UndeclaredQuery, {
        userId: string;
    }>;
    'DELETE /auth/groups/{id}/members/{userId}': Op<{ id: string | number; userId: string | number }>;
    'GET /auth/integrations/credentials': Op;
    'DELETE /auth/integrations/credentials/{provider}': Op<{ provider: string | number }>;
    'GET /auth/invitations': Op;
    'POST /auth/invitations': Op<NoParams, UndeclaredQuery, {
        email: string;
        role?: string;
    }>;
    'DELETE /auth/invitations/{id}': Op<{ id: string | number }>;
    'GET /auth/invite/{token}': Op<{ token: string | number }>;
    'GET /auth/login': Op;
    'GET /auth/login-pickup': Op<NoParams, {
        id: string;
    }>;
    'GET /auth/login/{provider}': Op<{ provider: string | number }>;
    'POST /auth/logout': Op;
    'GET /auth/me/active-features': Op;
    'PUT /auth/me/active-features': Op<NoParams, UndeclaredQuery, {
        betaEnabled?: Array<string>;
        integrationsEnabled?: Array<string>;
    }>;
    'GET /auth/me/consumer-features': Op;
    'GET /auth/me/group-access': Op;
    'PUT /auth/me/org-access': Op<NoParams, UndeclaredQuery, {
        granted: Array<string>;
    }>;
    'POST /auth/mfa/assist': Op<NoParams, UndeclaredQuery, {
        history?: Array<unknown>;
        question: string;
    }>;
    'POST /auth/mfa/disable': Op<NoParams, UndeclaredQuery, {
        code?: string;
        securityKey?: {
            id: string;
            rawId: string;
            response: Record<string, unknown>;
            type: 'public-key';
            [key: string]: unknown;
        };
    }>;
    'POST /auth/mfa/enable': Op<NoParams, UndeclaredQuery, {
        code: string;
        proof?: {
            code?: string;
            securityKey?: {
                id: string;
                rawId: string;
                response: Record<string, unknown>;
                type: 'public-key';
                [key: string]: unknown;
            };
        };
    }>;
    'POST /auth/mfa/recovery-codes/regenerate': Op<NoParams, UndeclaredQuery, {
        code?: string;
        securityKey?: {
            id: string;
            rawId: string;
            response: Record<string, unknown>;
            type: 'public-key';
            [key: string]: unknown;
        };
    }>;
    'POST /auth/mfa/security-key/options': Op<NoParams, UndeclaredQuery, Record<string, never>>;
    'POST /auth/mfa/security-key/verify-login': Op<NoParams, UndeclaredQuery, {
        response: {
            id: string;
            rawId: string;
            response: Record<string, unknown>;
            type: 'public-key';
            [key: string]: unknown;
        };
    }>;
    'GET /auth/mfa/security-keys': Op;
    'POST /auth/mfa/security-keys/proof/options': Op<NoParams, UndeclaredQuery, Record<string, never>>;
    'POST /auth/mfa/security-keys/registration/options': Op<NoParams, UndeclaredQuery, {
        code?: string;
        name?: string;
        securityKey?: {
            id: string;
            rawId: string;
            response: Record<string, unknown>;
            type: 'public-key';
            [key: string]: unknown;
        };
    }>;
    'POST /auth/mfa/security-keys/registration/verify': Op<NoParams, UndeclaredQuery, {
        response: {
            id: string;
            rawId: string;
            response: Record<string, unknown>;
            type: 'public-key';
            [key: string]: unknown;
        };
    }>;
    'PATCH /auth/mfa/security-keys/{id}': Op<{ id: string | number }, UndeclaredQuery, {
        name: string;
    }>;
    'DELETE /auth/mfa/security-keys/{id}': Op<{ id: string | number }>;
    'POST /auth/mfa/setup': Op<NoParams, UndeclaredQuery, {
        force?: boolean;
    }>;
    'GET /auth/mfa/status': Op;
    'POST /auth/mfa/verify-login': Op<NoParams, UndeclaredQuery, {
        code: string;
    }>;
    'GET /auth/microsoft/link-requests': Op;
    'GET /auth/microsoft/sync-binding': Op;
    'PUT /auth/microsoft/sync-binding': Op<NoParams, UndeclaredQuery, {
        syncOrganizationId: string;
        syncTenantId: string;
    }>;
    'PUT /auth/microsoft/users/{userId}/identity': Op<{ userId: string | number }, UndeclaredQuery, {
        requestId: string;
    }>;
    'DELETE /auth/microsoft/users/{userId}/identity': Op<{ userId: string | number }>;
    'GET /auth/my-entitlements': Op;
    'GET /auth/my-permissions': Op;
    'GET /auth/oauth-config': Op;
    'PUT /auth/oauth-config': Op<NoParams, UndeclaredQuery, {
        clientId?: string;
        clientSecret?: string;
        nextcloudUrl?: string;
    }>;
    'POST /auth/oauth-config/test': Op<NoParams, UndeclaredQuery, Record<string, never>>;
    'POST /auth/opaque/login/finish': Op<NoParams, UndeclaredQuery, {
        encryptedDEK?: Record<string, unknown> | null;
        finishLoginRequest: string;
        loginId: string;
    }>;
    'POST /auth/opaque/login/start': Op<NoParams, UndeclaredQuery, {
        startLoginRequest: string;
        username: string;
    }>;
    'POST /auth/opaque/pin/login/finish': Op<NoParams, UndeclaredQuery, {
        encryptedDEK?: Record<string, unknown> | null;
        finishLoginRequest: string;
        loginId: string;
    }>;
    'POST /auth/opaque/pin/login/start': Op<NoParams, UndeclaredQuery, {
        startLoginRequest: string;
    }>;
    'POST /auth/opaque/pin/register/finish': Op<NoParams, UndeclaredQuery, {
        confirmReplace?: boolean;
        recoveryWrappedDEK?: Record<string, unknown>;
        registrationRecord: string;
        wrappedDEK: Record<string, unknown>;
    }>;
    'POST /auth/opaque/pin/register/start': Op<NoParams, UndeclaredQuery, {
        registrationRequest: string;
        username?: string;
    }>;
    'POST /auth/opaque/register/finish': Op<NoParams, UndeclaredQuery, {
        confirmReplace?: boolean;
        kekSalt?: string;
        recoveryWrappedDEK?: Record<string, unknown>;
        registrationRecord: string;
        username?: string;
        wrappedDEK: Record<string, unknown>;
    }>;
    'POST /auth/opaque/register/start': Op<NoParams, UndeclaredQuery, {
        registrationRequest: string;
        username?: string;
    }>;
    'GET /auth/opaque/status': Op;
    'GET /auth/org-roles': Op;
    'PUT /auth/org-roles/{roleId}': Op<{ roleId: string | number }, UndeclaredQuery, {
        permissions: Array<string>;
    }>;
    'GET /auth/organizations': Op;
    'POST /auth/organizations': Op<NoParams, UndeclaredQuery, {
        address?: string;
        allowSignup?: boolean;
        defaultGroups?: Array<string>;
        description?: string;
        email?: string;
        footerText?: string;
        kvk?: string;
        logo?: string;
        name: string;
        phone?: string;
        tagline?: string;
        vat?: string;
        website?: string;
    }>;
    'GET /auth/organizations/public': Op;
    'GET /auth/organizations/{id}': Op<{ id: string | number }>;
    'PUT /auth/organizations/{id}': Op<{ id: string | number }>;
    'DELETE /auth/organizations/{id}': Op<{ id: string | number }>;
    'GET /auth/organizations/{id}/encryption': Op<{ id: string | number }>;
    'PUT /auth/organizations/{id}/encryption': Op<{ id: string | number }, UndeclaredQuery, {
        scope?: Record<string, unknown> | null;
        tier?: string;
    }>;
    'GET /auth/organizations/{id}/encryption/backfill': Op<{ id: string | number }>;
    'POST /auth/organizations/{id}/encryption/backfill': Op<{ id: string | number }, UndeclaredQuery, {
        dryRun: boolean;
    }>;
    'POST /auth/organizations/{id}/logo': Op<{ id: string | number }>;
    'DELETE /auth/organizations/{id}/logo': Op<{ id: string | number }>;
    'GET /auth/organizations/{orgId}/active-beta-features': Op<{ orgId: string | number }>;
    'PUT /auth/organizations/{orgId}/active-beta-features': Op<{ orgId: string | number }, UndeclaredQuery, {
        enabled: Array<string>;
    }>;
    'GET /auth/organizations/{orgId}/active-integrations': Op<{ orgId: string | number }>;
    'PUT /auth/organizations/{orgId}/active-integrations': Op<{ orgId: string | number }, UndeclaredQuery, {
        enabled: Array<string>;
    }>;
    'PUT /auth/organizations/{orgId}/beta-features': Op<{ orgId: string | number }, UndeclaredQuery, {
        features: Array<string>;
    }>;
    'GET /auth/organizations/{orgId}/group-access': Op<{ orgId: string | number }>;
    'PUT /auth/organizations/{orgId}/org-access': Op<{ orgId: string | number }, UndeclaredQuery, {
        granted: Array<string>;
    }>;
    'GET /auth/organizations/{orgId}/org-availability': Op<{ orgId: string | number }>;
    'PUT /auth/organizations/{orgId}/org-availability': Op<{ orgId: string | number }, UndeclaredQuery, {
        available?: Array<string>;
        unrestricted?: boolean;
    }>;
    'GET /auth/pending-invite': Op;
    'POST /auth/pending-invite/clear': Op<NoParams, UndeclaredQuery, Record<string, never>>;
    'POST /auth/pending-signup': Op<NoParams, UndeclaredQuery, {
        authMethod?: 'password' | 'google' | 'microsoft';
        captchaToken?: string;
        inviteToken?: 'session';
        locale?: string | null;
        newOrgName?: string;
        orgDetails?: Record<string, unknown>;
        privacyShield?: Record<string, unknown> | null;
        selectedPlanId?: string | null;
        signupType?: 'consumer' | 'org';
    }>;
    'GET /auth/permissions': Op;
    'GET /auth/providers': Op;
    'GET /auth/providers/{provider}': Op<{ provider: string | number }>;
    'PUT /auth/providers/{provider}': Op<{ provider: string | number }, UndeclaredQuery, {
        clientId?: string;
        clientSecret?: string;
        connections?: Array<{
            clientId: string;
            clientSecret?: string;
            id?: string;
            label: string;
            logo?: string;
            tenantId?: string;
        }>;
        label?: string;
        logo?: string;
        tenantId?: string;
        url?: string;
    }>;
    'POST /auth/providers/{provider}/test': Op<{ provider: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /auth/redeem-invite/{token}': Op<{ token: string | number }>;
    'POST /auth/resend-verification': Op<NoParams, UndeclaredQuery, {
        email: string;
    }>;
    'POST /auth/reset-password': Op<NoParams, UndeclaredQuery, {
        newPassword: string;
        token: string;
    }>;
    'GET /auth/roles': Op;
    'POST /auth/roles': Op<NoParams, UndeclaredQuery, {
        description?: string;
        name: string;
        permissions?: unknown;
    }>;
    'PUT /auth/roles/{id}': Op<{ id: string | number }, UndeclaredQuery, {
        description?: string;
        name?: string;
        permissions?: unknown;
    }>;
    'DELETE /auth/roles/{id}': Op<{ id: string | number }>;
    'POST /auth/save-app-password': Op<NoParams, UndeclaredQuery, {
        password: string;
        url?: string;
        username: string;
    }>;
    'GET /auth/settings': Op;
    'POST /auth/settings': Op<NoParams, UndeclaredQuery, {
        clientId: string;
        clientSecret?: string;
        nextcloudUrl: string;
    }>;
    'POST /auth/setup': Op<NoParams, UndeclaredQuery, {
        password: string;
    }>;
    'GET /auth/setup-status': Op;
    'POST /auth/signup': Op<NoParams, UndeclaredQuery, {
        captchaToken?: string;
        displayName?: string;
        email?: string;
        firstName?: string;
        inviteToken?: string;
        lastName?: string;
        locale?: string | null;
        newOrgName?: string;
        orgDetails?: Record<string, unknown>;
        organizationId?: string;
        password: string;
        privacyShield?: Record<string, unknown> | null;
        selectedPlanId?: string | null;
        username: string;
    }>;
    'POST /auth/sso-change-pin': Op<NoParams, UndeclaredQuery, {
        newPin: string;
        oldPin: string;
    }>;
    'POST /auth/sso-encryption-setup': Op<NoParams, UndeclaredQuery, {
        pin: string;
    }>;
    'POST /auth/sso-encryption-unlock': Op<NoParams, UndeclaredQuery, {
        pin: string;
    }>;
    'POST /auth/sso-recovery': Op<NoParams, UndeclaredQuery, {
        newPin: string;
        recoveryKey: string;
    }>;
    'POST /auth/update-profile': Op<NoParams, UndeclaredQuery, {
        avatar?: string | null;
        avatarType?: 'emoji' | 'url' | 'image' | '' | null;
        displayName?: string;
    }>;
    'GET /auth/user': Op;
    'GET /auth/users': Op;
    'POST /auth/users': Op<NoParams, UndeclaredQuery, {
        avatar?: string | null;
        avatarType?: string | null;
        displayName?: string;
        email?: string;
        firstName?: string;
        groups?: Array<string>;
        lastName?: string;
        orgRole?: string;
        organizationId?: string;
        password: string;
        phone?: string;
        role?: string;
        username: string;
    }>;
    'POST /auth/users/me/leave-org': Op<NoParams, UndeclaredQuery, {
        transferTo: string;
    }>;
    'PUT /auth/users/{id}': Op<{ id: string | number }>;
    'DELETE /auth/users/{id}': Op<{ id: string | number }>;
    'POST /auth/users/{id}/avatar': Op<{ id: string | number }>;
    'DELETE /auth/users/{id}/avatar': Op<{ id: string | number }>;
    'POST /auth/users/{id}/mfa/reset': Op<{ id: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /auth/verify-email/{token}': Op<{ token: string | number }>;
    'POST /auth/webhook/nc-user-sync': Op;
    'POST /execute': Op<NoParams, UndeclaredQuery, {
        workflow: {
            edges: Array<Record<string, unknown>>;
            nodes: Array<Record<string, unknown>>;
            [key: string]: unknown;
        };
        workflowId?: string;
        workflowName?: string;
    }>;
    'GET /integrations/directory': Op;
    'GET /integrations/{id}': Op<{ id: string | number }>;
    'GET /llms.txt': Op;
    'GET /mcp': Op;
    'POST /mcp': Op;
    'GET /mcp/automations': Op;
    'POST /mcp/automations': Op;
    'GET /mcp/cms': Op;
    'POST /mcp/cms': Op;
    'PUT /mcp/cms/upload/{ticketId}': Op<{ ticketId: string | number }>;
    'GET /mcp/studio': Op;
    'POST /mcp/studio': Op;
    'GET /reports/types': Op;
    'GET /reports/{type}': Op<{ type: string | number }, {
        endDate?: string;
        startDate?: string;
    }>;
    'GET /robots.txt': Op;
    'GET /share/_brand/icon.svg': Op;
    'GET /share/{token}': Op<{ token: string | number }>;
    'GET /share/{token}/content': Op<{ token: string | number }>;
    'GET /share/{token}/extras/{path}': Op<{ token: string | number; path: string | number }>;
    'POST /share/{token}/unlock': Op<{ token: string | number }>;
    'GET /sitemap.xml': Op;
    'POST /subworkflow/{workflowId}': Op<{ workflowId: string | number }, UndeclaredQuery, {
        callerId?: string;
        inputData?: unknown;
    }>;
    'GET /verify/{token}': Op<{ token: string | number }>;
    'GET /verify/{token}/certificate.pdf': Op<{ token: string | number }>;
    'GET /verify/{token}/image.png': Op<{ token: string | number }>;
    'GET /versions/{agentId}': Op<{ agentId: string | number }>;
    'POST /versions/{agentId}/pre-refine': Op<{ agentId: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /versions/{agentId}/{versionId}': Op<{ agentId: string | number; versionId: string | number }>;
    'DELETE /versions/{agentId}/{versionId}': Op<{ agentId: string | number; versionId: string | number }, UndeclaredQuery, Record<string, never>>;
    'POST /versions/{agentId}/{versionId}/restore': Op<{ agentId: string | number; versionId: string | number }, UndeclaredQuery, Record<string, never>>;
    'GET /w/_brand/icon.svg': Op;
    'GET /w/{token}': Op<{ token: string | number }>;
    'GET /w/{token}/content': Op<{ token: string | number }>;
    'GET /w/{token}/extras/{path}': Op<{ token: string | number; path: string | number }>;
    'POST /w/{token}/unlock': Op<{ token: string | number }>;
}

export type ApiOperationKey = keyof ApiOperations;
