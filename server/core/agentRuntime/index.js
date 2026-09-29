/**
 * Agent Runtime — re-exports all modules
 * Maintains backward compatibility with require('./core/agentRuntime')
 */
const { resolveAgentModel } = require('./modelResolver');
const { getAgentTools, getAvailableComponents } = require('./agentTools');
const { chatWithAgent } = require('./chatWithAgent');
const { chatWithAgentStream } = require('./chatStream');
const { generateChatTitle } = require('./chatTitle');
const componentManager = require('../cms/componentManager');
const { componentToTool, executeComponentTool, SYSTEM_TOOLS } = require('../tools/toolExecution');
const { processSystemPrompt } = require('../llm/promptUtils');

module.exports = {
    chatWithAgent,
    chatWithAgentStream,
    getAgentTools,
    getAvailableComponents,
    componentToTool,
    executeComponentTool,
    generateChatTitle,
    SYSTEM_TOOLS,
    componentManager,
    processSystemPrompt,
    resolveAgentModel
};
