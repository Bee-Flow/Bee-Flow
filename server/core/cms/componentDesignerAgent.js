/**
 * The Component Studio's designer agent: a chat loop against an
 * OpenAI-compatible endpoint that can call the studio's components as tools,
 * and extracts the component JSON the model writes. It backs
 * routes/ai/agentChat.js (POST /api/ai/chat, /chat-stream, /clear and
 * GET /history) and nothing else; every other chat surface runs through
 * core/agentRuntime.
 *
 * One agent per browser session, held in this process.
 */

const agentStore = require('../../stores/agentStore');
const log = require('../../telemetry/log');
const { getAIConfig } = require('../llm/providerConfig');

// System prompt for the Component Designer is now loaded from the DB (seeded from prompts/component-designer.md).
// This fallback is only used if the system agent doesn't exist in the DB.
const SYSTEM_PROMPT_FALLBACK = 'You are a BeeFlow component designer. You create and maintain Node.js workflow components.';

class ComponentDesignerAgent {
    constructor() {
        this.conversationHistory = [];
        this.enabledTools = []; // Component IDs that can be used as tools
        this.toolCalls = []; // Track tool executions for UI display
    }

    // Set which tools/components the agent can use
    setEnabledTools(componentIds) {
        this.enabledTools = componentIds || [];
    }

    // Get tools in OpenAI format for enabled components
    async getToolsForRequest() {
        // ALWAYS include System Tools for the AI Agent
        const { componentToTool, SYSTEM_TOOLS } = require('../agentRuntime');
        const componentManager = require('./componentManager');

        let tools = [];

        // Load tools from the Component Designer system agent configuration
        try {
            const designerAgentId = 'system-component-designer';
            const agentToolIds = await agentStore.getAgentTools(designerAgentId);

            if (agentToolIds && agentToolIds.length > 0) {
                log.info('[AIAgent] Loading tools from designer agent config:', agentToolIds);
                const allComponents = componentManager.getComponents();
                const designerComponents = allComponents.filter(c =>
                    agentToolIds.includes(c.id) && c.definition?.agentEnabled === true
                );
                tools.push(...designerComponents.map(componentToTool));
            }
        } catch (e) {
            log.warn('[AIAgent] Failed to load designer agent tools:', e.message);
        }

        // Add enabled components (from frontend selection, if any)
        if (this.enabledTools.length > 0) {
            const allComponents = componentManager.getComponents();
            const enabledComponents = allComponents.filter(c =>
                this.enabledTools.includes(c.id) && c.definition?.agentEnabled === true
            );
            tools.push(...enabledComponents.map(componentToTool));
        }

        // Add System Tools (execute_component, update_component etc)
        if (SYSTEM_TOOLS) {
            tools.push(...SYSTEM_TOOLS);
        }

        log.info('[AIAgent] Total tools for request:', tools.length);

        return tools;
    }

    async chat(userMessage, tools = null, context = {}, onProgress = null) {
        // Get current config
        const config = await getAIConfig();

        // Update enabled tools if provided
        if (tools !== null) {
            this.setEnabledTools(tools);
        }

        // Update context
        this.currentContext = context || {};

        // Add user message to history
        this.conversationHistory.push({
            role: 'user',
            content: userMessage
        });

        // Reset tool calls for this request
        this.toolCalls = [];

        try {
            return await this._chatLoop(config, onProgress);
        } catch (error) {
            log.error('AI Agent error:', error);
            throw error;
        }
    }

    async _chatLoop(config, onProgress = null) {
        const maxIterations = 30;
        let iterations = 0;
        const tools = await this.getToolsForRequest();
        const emit = (type, detail) => { if (onProgress) onProgress({ type, detail }); };

        while (iterations < maxIterations) {
            iterations++;

            // Emit thinking status
            emit('thinking', { iteration: iterations });

            const headers = {
                'Content-Type': 'application/json'
            };

            if (config.apiKey) {
                headers['Authorization'] = `Bearer ${config.apiKey}`;
            }

            // Dynamic System Prompt — loaded from DB system agent, with context override
            let currentSystemPrompt = SYSTEM_PROMPT_FALLBACK;

            if (this.currentContext?.systemPrompt) {
                // Allow manual override via context
                currentSystemPrompt = this.currentContext.systemPrompt;
            } else {
                // Load from system agent DB entry
                try {
                    const designerAgent = await agentStore.getSystemAgent('system-component-designer');
                    if (designerAgent) {
                        if (designerAgent.system_prompt) currentSystemPrompt = designerAgent.system_prompt;
                        if (designerAgent.model) config.model = designerAgent.model;
                    }
                } catch (e) {
                    log.warn('[AIAgent] Failed to load designer agent config:', e.message);
                }
            }

            if (this.currentContext?.componentId) {
                currentSystemPrompt += `\n\n## CURRENT CONTEXT\nYou are currently editing component with ID: "${this.currentContext.componentId}".\nUse the 'read_component_files' tool to examine its current code before making changes.\nUse 'update_component' to apply verified changes.`;
            }

            const requestBody = {
                model: config.model,
                messages: [
                    { role: 'system', content: currentSystemPrompt },
                    ...this.conversationHistory
                ],
                temperature: 0.7,
                max_tokens: 8000
            };

            // Add tools if any are enabled
            if (tools.length > 0) {
                requestBody.tools = tools;
                requestBody.tool_choice = 'auto';
            }

            // Build API URL - handle providers with trailing slashes or /v1 in URL
            let apiUrl = config.url.replace(/\/+$/, ''); // Remove trailing slashes
            if (!apiUrl.endsWith('/v1')) {
                apiUrl = `${apiUrl}/v1`;
            }

            const response = await fetch(`${apiUrl}/chat/completions`, {
                method: 'POST',
                headers,
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                const error = await response.text();
                throw new Error(`Mistral API error: ${response.status} - ${error}`);
            }

            const data = await response.json();
            const assistantMessage = data.choices[0].message;

            // Debug logging
            log.info('[AIAgent] Response received:', {
                hasContent: !!assistantMessage.content,
                contentLength: assistantMessage.content?.length || 0,
                hasToolCalls: !!(assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0),
                toolCallCount: assistantMessage.tool_calls?.length || 0
            });

            // Check if there are tool calls to execute
            if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
                // Add assistant message with tool calls to history
                this.conversationHistory.push(assistantMessage);

                // Execute all tool calls in parallel
                const { executeComponentTool } = require('../agentRuntime');
                log.info(`[AIAgent] Executing ${assistantMessage.tool_calls.length} tools in parallel...`);

                const toolExecutionPromises = assistantMessage.tool_calls.map(async (toolCall) => {
                    const toolName = toolCall.function.name;
                    let toolArgs = {};

                    try {
                        toolArgs = JSON.parse(toolCall.function.arguments || '{}');
                    } catch (e) {
                        toolArgs = {};
                    }

                    log.info(`[AIAgent] Executing tool: ${toolName}`, toolArgs);
                    emit('tool', { name: toolName, args: toolArgs });

                    const toolResult = await executeComponentTool(toolName, toolArgs, {}, null);
                    return { toolCall, toolName, toolArgs, toolResult };
                });

                const toolResults = await Promise.all(toolExecutionPromises);

                // Process results in order
                for (const { toolCall, toolName, toolArgs, toolResult } of toolResults) {
                    this.toolCalls.push({
                        name: toolName,
                        args: toolArgs,
                        result: toolResult
                    });

                    this.conversationHistory.push({
                        role: 'tool',
                        tool_call_id: toolCall.id,
                        content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult)
                    });
                }

                // Continue the loop to get next response
                continue;
            }

            // No tool calls - we have the final response
            let content = assistantMessage.content;

            // Handle empty content (sometimes AI returns null/empty)
            if (!content || content.trim() === '') {
                log.warn('[AIAgent] Received empty content from AI, providing fallback');
                content = "I'm ready to help you create a component. Please describe what you need.";
            }

            this.conversationHistory.push({
                role: 'assistant',
                content: content
            });

            // Try to extract component JSON if present
            emit('finalizing', {});
            const componentData = this.extractComponentData(content);

            return {
                message: content,
                component: componentData,
                toolCalls: this.toolCalls,
                conversationLength: this.conversationHistory.length
            };
        }

        throw new Error('AI Agent exceeded maximum tool call iterations');
    }

    extractComponentData(message) {
        // Handle null/undefined message
        if (!message) return null;

        // Try multiple patterns for JSON code blocks
        const patterns = [
            /```json\s*\n([\s\S]*?)\n```/,           // Standard: ```json\n...\n```
            /```json\s*([\s\S]*?)```/,               // No newline after json
            /```\s*\n?\s*(\{[\s\S]*?"code"[\s\S]*?\})\s*```/,  // Generic code block with component
        ];

        for (const pattern of patterns) {
            const match = message.match(pattern);
            if (match) {
                try {
                    const jsonStr = match[1].trim();
                    const data = JSON.parse(jsonStr);
                    // Validate it looks like a component
                    if (data.id && data.name && data.code) {
                        log.info('[AIAgent] Extracted component:', data.id);
                        return data;
                    }
                } catch (e) {
                    log.info('[AIAgent] JSON parse failed for pattern, trying next...', e.message);
                }
            }
        }

        log.info('[AIAgent] No component JSON found in message');
        return null;
    }

    clearHistory() {
        this.conversationHistory = [];
        this.toolCalls = [];
    }

    getHistory() {
        return this.conversationHistory;
    }

    getToolCalls() {
        return this.toolCalls;
    }
}

// Store active conversations by session
const conversations = new Map();

function getOrCreateAgent(sessionId) {
    if (!conversations.has(sessionId)) {
        conversations.set(sessionId, new ComponentDesignerAgent());
    }
    return conversations.get(sessionId);
}

function clearConversation(sessionId) {
    if (conversations.has(sessionId)) {
        conversations.get(sessionId).clearHistory();
    }
}

module.exports = { ComponentDesignerAgent, getOrCreateAgent, clearConversation };
