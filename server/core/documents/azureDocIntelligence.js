// @typecheck
/**
 * Azure AI Document Intelligence — extract structured content from documents.
 *
 * Uses the Layout model with Markdown output for LLM-friendly extraction.
 * Supports: PDF, DOCX, XLSX, PPTX, JPEG, PNG, TIFF, BMP.
 *
 * SDK: @azure-rest/ai-document-intelligence
 * Auth: AzureKeyCredential from @azure/core-auth
 * API: 2024-11-30 GA (pinned — best Markdown quality)
 *
 * Config stored in configStore (same pattern as piiDetection.js):
 *   - azure_doc_intelligence_endpoint (config)
 *   - azure_doc_intelligence_key (secret, encrypted at rest)
 *
 * Output: always clean Markdown — zero HTML tags, no Azure DI structural
 * comments, all tables converted to Markdown table syntax.
 */

const configStore = require('../../stores/configStore');
const { computeDocIntelligenceCost } = require('../azureServiceCosts');
const azureServiceUsageStore = require('../../stores/azureServiceUsageStore');
const log = require('../../telemetry/log');

// ── Cached client ────────────────────────────────────────────────
let _client = null;
let _clientConfig = null;

/**
 * Create or return cached Azure Document Intelligence client.
 * @returns {Promise<object|null>} The client, or null if not configured.
 */
async function getClient() {
    const endpoint = await configStore.getConfig('azure_doc_intelligence_endpoint');
    const apiKey = await configStore.getSecret('azure_doc_intelligence_key');

    if (!endpoint || !apiKey) {
        return null;
    }

    const configKey = `${endpoint}:${apiKey}`;
    if (_client && _clientConfig === configKey) {
        return _client;
    }

    const DocumentIntelligence = require('@azure-rest/ai-document-intelligence').default;
    const { AzureKeyCredential } = require('@azure/core-auth');

    _client = DocumentIntelligence(endpoint, new AzureKeyCredential(apiKey));
    _clientConfig = configKey;
    return _client;
}

/**
 * Extract text from a document buffer using Azure AI Document Intelligence,
 * together with the extraction statistics Azure reports back.
 *
 * Returns structured Markdown content using the Layout model plus the page
 * count Azure counted (also what the service bills on), so ingestion can
 * record it on the document row instead of guessing.
 *
 * @param {Buffer} buffer - Raw file bytes
 * @param {string} filename - Original filename (for logging)
 * @returns {Promise<{ text: string, pageCount: number, pages?: Array<object> }>} Extracted Markdown content + page count (+ per-page spans)
 * @throws {Error} If extraction fails or service is not configured
 */
async function extractWithAzureWithStats(buffer, filename = 'unknown') {
    const client = await getClient();
    if (!client) {
        throw new Error('Azure Document Intelligence is not configured. Set endpoint and key in admin settings.');
    }

    log.info(`[AzureDocIntelligence] Analyzing document: ${filename} (${buffer.length} bytes)`);

    const base64Source = buffer.toString('base64');

    // Use the Layout model with Markdown output (API pinned to 2024-11-30 GA)
    const initialResponse = await client
        .path('/documentModels/{modelId}:analyze', 'prebuilt-layout')
        .post({
            contentType: 'application/json',
            body: {
                base64Source,
            },
            queryParameters: {
                'api-version': '2024-11-30',
                outputContentFormat: 'markdown',
            },
        });

    if (initialResponse.status !== '202') {
        const errorBody = initialResponse.body;
        throw new Error(`Azure Document Intelligence error: ${initialResponse.status} - ${JSON.stringify(errorBody)}`);
    }

    // Poll for result
    const operationLocation = initialResponse.headers['operation-location'];
    if (!operationLocation) {
        throw new Error('Azure Document Intelligence: No operation-location header in response');
    }

    require('@azure/core-auth');
    await configStore.getConfig('azure_doc_intelligence_endpoint');
    const apiKey = await configStore.getSecret('azure_doc_intelligence_key');

    const maxPolls = 60; // 60 * 2s = 2 minutes max
    const pollIntervalMs = 2000;

    for (let i = 0; i < maxPolls; i++) {
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

        const pollResponse = await fetch(operationLocation, {
            headers: {
                'Ocp-Apim-Subscription-Key': apiKey,
            },
        });

        if (!pollResponse.ok) {
            throw new Error(`Azure Document Intelligence poll error: ${pollResponse.status}`);
        }

        const result = /** @type {{ status?: string, analyzeResult?: Record<string, any>, error?: { code?: string, message?: string } }} */ (await pollResponse.json());

        if (result.status === 'succeeded') {
            const rawContent = result.analyzeResult?.content || '';
            const pageCount = result.analyzeResult?.pages?.length || 0;

            if (!rawContent.trim()) {
                log.warn(`[AzureDocIntelligence] No content extracted from ${filename} (${pageCount} pages)`);
                return { text: '', pageCount };
            }

            // Apply cleanup: strips Azure DI artifacts, converts HTML tables → Markdown.
            //
            // `withPages` keeps what the cleanup would otherwise destroy: the
            // `<!-- PageBreak -->` markers are the only record of where a page
            // ended, and step 1 removes them (correctly — a marker left in the
            // text would surface inside a citation's excerpt). Splitting on
            // them first is what lets a chunk say "p. 12" later.
            const { cleanAzureDocMarkdown } = require('../text/markdownCleanup');
            const { text: content, pages } = cleanAzureDocMarkdown(rawContent, { withPages: true });

            log.info(`[AzureDocIntelligence] Extracted ${rawContent.length} → ${content.length} chars from ${filename} (${pageCount} pages)`);

            // ── Track usage cost (fire-and-forget) ──
            const cost = computeDocIntelligenceCost(pageCount);
            azureServiceUsageStore.logAzureServiceUsage({
                service_type: 'doc_intelligence',
                pages: pageCount,
                input_chars: rawContent.length,
                estimated_cost: cost,
                source: 'unknown',
                metadata: { filename, content_length: content.length },
            }).catch(() => {});
            if (cost > 0) log.info(`[AzureDocIntelligence] 💰 Est. cost: $${cost.toFixed(4)} (${pageCount} pages)`);

            // `pages` rides along beside the flat text. Every existing caller
            // reads `text` (and some `pageCount`) and is unaffected; the KB
            // ingest path reads `pages` to stamp a page on each chunk.
            return { text: content, pageCount, pages };
        }

        if (result.status === 'failed') {
            const error = result.error || {};
            throw new Error(`Azure Document Intelligence analysis failed: ${error.code || 'unknown'} - ${error.message || 'unknown error'}`);
        }

        // status is 'running' or 'notStarted' — continue polling
    }

    throw new Error(`Azure Document Intelligence: Analysis timed out after ${maxPolls * pollIntervalMs / 1000}s for ${filename}`);
}

/**
 * Text-only wrapper over {@link extractWithAzureWithStats} — the historic
 * signature every existing caller uses.
 *
 * @param {Buffer} buffer - Raw file bytes
 * @param {string} filename - Original filename (for logging)
 * @returns {Promise<string>} Extracted Markdown content
 * @throws {Error} If extraction fails or service is not configured
 */
async function extractWithAzure(buffer, filename = 'unknown') {
    const { text } = await extractWithAzureWithStats(buffer, filename);
    return text;
}

/**
 * Check if Azure Document Intelligence is configured.
 * @returns {Promise<boolean>}
 */
async function isAzureDocIntelligenceConfigured() {
    const endpoint = await configStore.getConfig('azure_doc_intelligence_endpoint');
    const apiKey = await configStore.getSecret('azure_doc_intelligence_key');
    return !!(endpoint && apiKey);
}

module.exports = {
    extractWithAzure,
    extractWithAzureWithStats,
    isAzureDocIntelligenceConfigured,
};
