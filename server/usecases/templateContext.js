// @typecheck
const log = require('../telemetry/log');
const templateStore = require('../stores/templateStore');
const configStore = require('../stores/configStore');
const { getProviderForModel } = require('../core/aiAgent');
const { getAdapter } = require('../core/providers');

async function generateTemplateContext(templateId, userId, text, parameters) {
    log.info(`[Templates] Generating context + instructions for template ${templateId}...`);

    // Resolve writer tier model — MUST be configured
    const tiers = await configStore.getConfig('chat_model_tiers') || {};
    const writeTier = tiers['pro'] || {};
    const modelId = writeTier.modelId;
    if (!modelId) {
        throw new Error('Pro tier model not configured in chat_model_tiers');
    }

    const config = await getProviderForModel(modelId);
    const apiUrl = (config.url || '').replace(/\/+$/, '');
    const adapter = getAdapter(config.providerType, apiUrl);

    // Truncate text to avoid huge payloads (first ~6000 chars is enough for context)
    const truncatedText = text.length > 6000 ? text.slice(0, 6000) + '\n\n[... document continues ...]' : text;

    const paramList = parameters.length > 0
        ? parameters.map(p => `- ${p.name}${p.description ? ': ' + p.description : ''}`).join('\n')
        : '(none detected)';

    const messages = [
        {
            role: 'system',
            content: `You are a document analysis assistant. Analyze the uploaded Word template and generate TWO sections:

SECTION 1 — DESCRIPTION:
A concise context summary (2-4 paragraphs) covering: document type, purpose, key sections, and what information is needed to fill the template parameters.

SECTION 2 — INSTRUCTIONS:
Specific instructions for an AI that will fill this template. These should cover:
- What language to use (detect from the document content)
- Tone and formality level
- Any formatting conventions to follow
- Domain-specific knowledge needed
- How to handle each parameter
- Any legal/compliance considerations if applicable

Write both sections in the same language as the document.

Separate the two sections with exactly this line on its own:
---INSTRUCTIONS---

First write the description, then the separator line, then the instructions. Do NOT use any other formatting, headers, or wrapping.`
        },
        {
            role: 'user',
            content: `Template document content:\n\n---\n${truncatedText}\n---\n\nDetected parameters:\n${paramList}\n\nGenerate the description and then the instructions.`
        }
    ];

    /** @type {{ choices?: { message?: { content?: string } }[], content?: unknown } | null} */
    const response = await adapter.chat(config.apiKey, apiUrl, modelId, messages, {
        maxTokens: 1000,
        temperature: 0.3,
    });

    // Extract content from various adapter response shapes
    let raw = '';
    if (response?.choices?.[0]?.message?.content) {
        raw = response.choices[0].message.content;
    } else if (response?.content) {
        raw = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
    } else if (typeof response === 'string') {
        raw = response;
    }
    raw = raw.trim();
    if (!raw) return;

    log.info(`[Templates] AI response (${raw.length} chars)`);

    // Split on the separator
    /** @type {{ description?: string; instructions?: string }} */
    const updates = {};
    if (raw.includes('---INSTRUCTIONS---')) {
        const parts = raw.split('---INSTRUCTIONS---');
        updates.description = parts[0].trim();
        updates.instructions = parts[1].trim();
    } else {
        // Fallback: use everything as description
        updates.description = raw;
    }

    if (Object.keys(updates).length > 0) {
        await templateStore.updateTemplate(templateId, userId, updates);
        log.info(`[Templates] Auto-generated context + instructions for ${templateId} (desc: ${(updates.description || '').length}c, instr: ${(updates.instructions || '').length}c)`);
    }
}

module.exports = { generateTemplateContext };
