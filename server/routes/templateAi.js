// @typecheck
const fs = require('fs');
const log = require('../telemetry/log');
const mammoth = require('mammoth');
const templateStore = require('../stores/templateStore');
const storageStore = require('../stores/storageStore');
const configStore = require('../stores/configStore');
const { getProviderForModel } = require('../core/aiAgent');
const { getAdapter } = require('../core/providers');
const { badRequest } = require('../core/http/errors');
const { autoCreateTemplateKB } = require('./templateKb');
const { generateTemplateContext } = require('./templateContext');

/**
 * The file behind a `local:` storage key, and only if it lies under
 * data/templates — the one place the upload above writes. The key comes
 * from the database, so a row edited to point elsewhere is refused rather
 * than read, streamed or overwritten.
 */
function localTemplateFile(storageKey) {
    const nodePath = require('path');
    const root = nodePath.resolve(__dirname, '..', 'data', 'templates');
    const file = nodePath.resolve(String(storageKey).slice('local:'.length));
    if (!file.startsWith(root + nodePath.sep)) throw badRequest('invalid_storage_key', 'Template file is outside template storage');
    return file;
}

function extractParameters(text) {
    const regex = /\{\{([^}]+)\}\}/g;
    const seen = new Set();
    const params = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
        const raw = match[1].trim();
        // Split on first colon: {{Name: description}}
        const colonIdx = raw.indexOf(':');
        let name, description;
        if (colonIdx > 0) {
            name = raw.slice(0, colonIdx).trim();
            description = raw.slice(colonIdx + 1).trim();
        } else {
            name = raw;
            description = '';
        }
        if (!seen.has(name)) {
            seen.add(name);
            params.push({ name, description });
        }
    }
    return params;
}

async function autoParameterizeTemplate(templateId, userId, extractedText, originalBuffer) {
    log.info(`[Templates] Auto-parameterizing template ${templateId}...`);

    // Resolve writer tier model
    const tiers = await configStore.getConfig('chat_model_tiers') || {};
    const writeTier = tiers['pro'] || {};
    const modelId = writeTier.modelId;
    if (!modelId) {
        throw new Error('pro tier model not configured in chat_model_tiers');
    }

    const config = await getProviderForModel(modelId);
    const apiUrl = (config.url || '').replace(/\/+$/, '');
    const adapter = getAdapter(config.providerType, apiUrl);

    // Send the full text (up to ~12000 chars) for thorough analysis
    const textForAI = extractedText.length > 12000
        ? extractedText.slice(0, 12000) + '\n\n[... document continues ...]'
        : extractedText;

    const messages = [
        {
            role: 'system',
            content: `You are a document parameterization expert. Your job is to analyze a Word document and identify ALL placeholders, fill-in fields, blanks, and variable content that should be converted into template parameters.

For each placeholder you find, return a JSON array entry with:
- "original": the EXACT text as it appears in the document (must match precisely for find-and-replace)
- "param_name": a lowercase_underscore parameter name
- "description": a clear description of what should be filled in (in the same language as the document)

Rules:
- Parameter names: lowercase, underscores, no spaces, descriptive
- Descriptions: clear and helpful, in the document's language
- Look for: [Invulveld], [Invullen: ...], <placeholder>, choice sections like "optie A / optie B", empty lines meant to be filled, version/date fields, company names, addresses, etc.
- Do NOT parameterize fixed legal text, article numbers, or boilerplate that should stay unchanged
- Be thorough — find EVERY fill-in field

Respond with ONLY a valid JSON array, no other text:
[
  {"original": "[exact text from document]", "param_name": "parameter_name", "description": "What goes here"},
  ...
]`
        },
        {
            role: 'user',
            content: `Analyze this document and find all placeholders to parameterize:\n\n---\n${textForAI}\n---`
        }
    ];

    /** @type {{ choices?: { message?: { content?: string } }[], content?: unknown } | null} */
    const response = await adapter.chat(config.apiKey, apiUrl, modelId, messages, {
        maxTokens: 4000,
        temperature: 0.1,
    });

    // Extract response content
    let raw = '';
    if (response?.choices?.[0]?.message?.content) {
        raw = response.choices[0].message.content;
    } else if (response?.content) {
        raw = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
    } else if (typeof response === 'string') {
        raw = response;
    }
    raw = raw.trim();
    if (!raw) throw new Error('Empty AI response');

    log.info(`[Templates] Parameterize AI response (${raw.length} chars)`);

    // Parse the JSON array
    let replacements;
    try {
        // Handle potential markdown fences
        const cleaned = raw.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();
        replacements = JSON.parse(cleaned);
    } catch (e) {
        log.error(`[Templates] Failed to parse parameterization JSON: ${e.message}`);
        log.error(`[Templates] Raw response: ${raw.slice(0, 500)}`);
        throw new Error('AI returned invalid JSON for parameterization');
    }

    if (!Array.isArray(replacements) || replacements.length === 0) {
        log.info(`[Templates] No replacements found for template ${templateId}`);
        return;
    }

    log.info(`[Templates] AI identified ${replacements.length} parameters to insert`);

    // ── Replace in .docx XML ─────────────────────────────────────
    const PizZip = require('pizzip');
    const zip = new PizZip(originalBuffer);

    const xmlFiles = Object.keys(zip.files).filter(f =>
        (f.endsWith('.xml') || f.endsWith('.xml.rels')) && !zip.files[f].dir
    );

    let totalReplacements = 0;

    for (const xmlFile of xmlFiles) {
        let content = zip.file(xmlFile).asText();
        let modified = false;

        for (const r of replacements) {
            if (!r.original || !r.param_name) continue;

            const paramTag = r.description
                ? `{{${r.param_name}: ${r.description}}}`
                : `{{${r.param_name}}}`;

            // Strategy 1: Direct text replacement (works when text isn't split across runs)
            if (content.includes(r.original)) {
                content = content.split(r.original).join(paramTag);
                modified = true;
                totalReplacements++;
                continue;
            }

            // Strategy 2: Handle Word's run-splitting by searching within <w:p> paragraphs
            // Word often splits text like "[Invullen: naam]" across multiple <w:r><w:t> elements
            const paragraphRegex = /<w:p[ >][\s\S]*?<\/w:p>/g;
            let match;
            const newContent = [];
            let lastIndex = 0;

            while ((match = paragraphRegex.exec(content)) !== null) {
                const paragraph = match[0];
                const paraStart = match.index;

                // Extract all text from <w:t> tags in this paragraph
                const textParts = [];
                const tRegex = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
                let tMatch;
                while ((tMatch = tRegex.exec(paragraph)) !== null) {
                    textParts.push({
                        text: tMatch[1],
                        fullMatch: tMatch[0],
                        index: tMatch.index
                    });
                }

                const fullText = textParts.map(t => t.text).join('');

                if (fullText.includes(r.original)) {
                    // Found it! Rebuild the paragraph with the replacement
                    // Find which text parts contain the original and replace across them
                    let rebuiltParagraph = paragraph;

                    // Simple approach: find the original in concatenated text,
                    // replace in the first <w:t> that starts the match,
                    // empty subsequent <w:t>'s that were part of the match
                    const origIdx = fullText.indexOf(r.original);
                    if (origIdx >= 0) {
                        let charCount = 0;
                        let startPartIdx = -1;
                        let endPartIdx = -1;
                        let startOffset = 0;

                        for (let i = 0; i < textParts.length; i++) {
                            const partEnd = charCount + textParts[i].text.length;

                            if (startPartIdx === -1 && origIdx < partEnd) {
                                startPartIdx = i;
                                startOffset = origIdx - charCount;
                            }
                            if (startPartIdx !== -1 && origIdx + r.original.length <= partEnd) {
                                endPartIdx = i;
                                break;
                            }
                            charCount += textParts[i].text.length;
                        }

                        if (startPartIdx >= 0 && endPartIdx >= 0) {
                            // Calculate end offset within the last part
                            let endCharCount = 0;
                            for (let i = 0; i < endPartIdx; i++) endCharCount += textParts[i].text.length;
                            const endOffset = origIdx + r.original.length - endCharCount;

                            // Build replacement for each text part
                            for (let i = startPartIdx; i <= endPartIdx; i++) {
                                const part = textParts[i];
                                let newText;

                                if (i === startPartIdx && i === endPartIdx) {
                                    // Single part contains whole match
                                    newText = part.text.slice(0, startOffset) + paramTag + part.text.slice(startOffset + r.original.length);
                                } else if (i === startPartIdx) {
                                    // First part of multi-part match
                                    newText = part.text.slice(0, startOffset) + paramTag;
                                } else if (i === endPartIdx) {
                                    // Last part of multi-part match
                                    newText = part.text.slice(endOffset);
                                } else {
                                    // Middle part — clear it
                                    newText = '';
                                }

                                const oldTag = part.fullMatch;
                                const preserveSpace = oldTag.includes('xml:space="preserve"') ? ' xml:space="preserve"' : '';
                                const newTag = `<w:t${preserveSpace}>${newText}</w:t>`;
                                rebuiltParagraph = rebuiltParagraph.split(oldTag).join(newTag);
                            }

                            newContent.push(content.slice(lastIndex, paraStart));
                            newContent.push(rebuiltParagraph);
                            lastIndex = paraStart + paragraph.length;
                            totalReplacements++;
                            modified = true;
                        }
                    }
                }
            }

            if (modified && newContent.length > 0) {
                newContent.push(content.slice(lastIndex));
                content = newContent.join('');
            }
        }

        if (modified) {
            zip.file(xmlFile, content);
        }
    }

    log.info(`[Templates] Made ${totalReplacements} replacements in .docx XML`);

    if (totalReplacements === 0) {
        log.info(`[Templates] No XML replacements made (text may not match exactly)`);
        // Still update the template with AI-identified parameters so they're visible
        const newParams = replacements
            .filter(r => r.param_name)
            .map(r => ({ name: r.param_name, description: r.description || '' }));
        if (newParams.length > 0) {
            await templateStore.updateTemplate(templateId, userId, { parameters: newParams });
        }
        return;
    }

    // Generate modified buffer
    const modifiedBuffer = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });

    // Re-upload the modified file
    const template = await templateStore.getTemplate(templateId, userId);
    if (!template) return;

    if (template.storageKey && !template.storageKey.startsWith('local:')) {
        // Re-upload to same RustFS key
        await storageStore.uploadFile(template.storageKey, modifiedBuffer,
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        log.info(`[Templates] Re-uploaded parameterized .docx to ${template.storageKey}`);
    } else if (template.storageKey?.startsWith('local:')) {
        await fs.promises.writeFile(localTemplateFile(template.storageKey), modifiedBuffer);
        log.info(`[Templates] Updated local parameterized .docx`);
    }

    // Re-extract parameters from the modified text
    const newResult = await mammoth.extractRawText({ buffer: modifiedBuffer });
    const newText = newResult.value || '';
    const newParams = extractParameters(newText);

    await templateStore.updateTemplate(templateId, userId, { parameters: newParams });
    log.info(`[Templates] Template ${templateId} now has ${newParams.length} parameters after auto-parameterization`);
}

module.exports = { localTemplateFile, extractParameters, generateTemplateContext, autoCreateTemplateKB, autoParameterizeTemplate };
