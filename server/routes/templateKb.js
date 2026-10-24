const log = require('../telemetry/log');
const templateStore = require('../stores/templateStore');
const kbStore = require('../stores/knowledgeBases');
const configStore = require('../stores/configStore');
const { getServiceHeaders } = require('../core/serviceAuth');

const SEARCH_SERVICE_URL = process.env.SEARCH_SERVICE_URL || 'https://services.beeflow.nl';

async function autoCreateTemplateKB(templateId, userId, fileName, text) {
    log.info(`[Templates] Auto-creating KB for template ${templateId}...`);

    const template = await templateStore.getTemplate(templateId, userId);
    if (!template) return;

    // Create a KB named after the template
    const kbName = `📄 ${template.name || fileName.replace(/\.docx$/i, '')}`;
    const kb = await kbStore.createKB(userId, kbName, `Auto-generated knowledge base for template "${template.name}"`);

    // Link the KB to the template
    const existingIds = template.knowledgeBaseIds || [];
    const newIds = [...existingIds, kb.id];
    await templateStore.updateTemplate(templateId, userId, { knowledgeBaseIds: newIds });

    // Ingest the document text into the KB
    const hash = kbStore.hashContent(text);
    const doc = await kbStore.createDocument(
        userId, kb.id,
        fileName, 'upload', fileName, hash
    );

    try {
        const useAzure = !!(await configStore.getConfig('use_azure_doc_processing'));
        const { resolveKbProvider } = require('../core/kb/resolveProvider');
        const kbProvider = await resolveKbProvider();
        const useLocalIngest = useAzure || kbProvider === 'local';

        if (useLocalIngest) {
            const { ingestLocally } = require('../core/kb/localKBIngest');
            const result = await ingestLocally(userId, kb.id, doc.id, text, {
                title: fileName,
                sourceUri: fileName,
            });
            await kbStore.updateChunkCount(doc.id, result.chunks_created || 0);
            await kbStore.bumpKBVersion(kb.id);
            log.info(`[Templates] Auto-KB "${kbName}" created locally with ${result.chunks_created || 0} chunks (kb_provider=${kbProvider})`);
        } else {
            const ingestRes = await fetch(`${SEARCH_SERVICE_URL}/kb/ingest/json`, {
                method: 'POST',
                headers: getServiceHeaders(),
                body: JSON.stringify({
                    tenant_id: userId,
                    knowledge_base_id: kb.id,
                    document_id: doc.id,
                    content: text,
                    title: fileName,
                    source_uri: fileName,
                }),
                signal: AbortSignal.timeout(120000)
            });

            if (ingestRes.ok) {
                const result = await ingestRes.json();
                await kbStore.updateChunkCount(doc.id, result.chunks_created || 0);
                await kbStore.bumpKBVersion(kb.id);
                log.info(`[Templates] Auto-KB "${kbName}" created with ${result.chunks_created || 0} chunks`);
            } else {
                const err = await ingestRes.text();
                log.warn(`[Templates] Auto-KB ingestion failed: ${err}`);
                await kbStore.deleteDocument(doc.id);
            }
        }
    } catch (e) {
        log.warn(`[Templates] Auto-KB ingestion error: ${e.message}`);
        await kbStore.deleteDocument(doc.id);
    }
}

module.exports = { autoCreateTemplateKB };
