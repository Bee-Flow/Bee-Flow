/**
 * Knowledge Bases — n8n ingestion.
 *
 * GET  /n8n/ingestible — org workflows flagged allowKbIngestion
 * POST /:id/ingest/n8n — ingest a workflow definition, or the payload its
 *                        webhook returns, as KB documents
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();
const kbStore = require('../../stores/knowledgeBases');
const configStore = require('../../stores/configStore');
const { requireAuth, requirePermission } = require('../../auth');
const { ingestDocument } = require('../../core/kb/kbIngestionHelpers');
const { getUserId, canAccessKB, blockIfSystemKB, ensureKbSource } = require('./shared');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

const WORKFLOW_TEXT = 'A workflow id is required — which n8n workflow to read.';
const MODE_TEXT = 'mode is "data" (run the webhook) or "definition" (the flow itself).';
const IngestN8nBody = z.object({
    workflowId: z.string({ required_error: WORKFLOW_TEXT, invalid_type_error: WORKFLOW_TEXT })
        .trim().min(1, WORKFLOW_TEXT),
    mode: z.enum(['data', 'definition'], { errorMap: () => ({ message: MODE_TEXT }) }).default('data'),
}).strict();

/**
 * Get n8n workflows that are configured with allowKbIngestion=true
 */
router.get('/n8n/ingestible', requireAuth, async (req, res) => {
    const userStore = require('../../stores/userStore');
    const user = await userStore.getUser(getUserId(req));
    if (!user || !user.organizationId) {
        return res.json([]);
    }
    
    const orgWorkflows = await configStore.getConfig(`n8n_workflows_org_${user.organizationId}`);
    if (!orgWorkflows || !Array.isArray(orgWorkflows)) {
        return res.json([]);
    }

    const ingestible = orgWorkflows.filter(wf => wf.allowKbIngestion === true);
    res.json(ingestible);
});


/**
 * Ingest an n8n workflow definition into a KB
 * 
 * Fetches the workflow from the connected n8n instance, converts it
 * to structured Markdown, and ingests it as a KB document.
 */
router.post('/:id/ingest/n8n', requireAuth, requirePermission('manage_knowledge'), validate({ body: IngestN8nBody }), async (req, res, next) => {
    try {
        const kb = await kbStore.getKB(req.params.id);
        if (!kb) return res.status(404).json({ error: 'KB not found' });
        if (!(await canAccessKB(req, kb))) return res.status(403).json({ error: 'Access denied' });
        if (blockIfSystemKB(kb, res)) return;

        const { workflowId, mode } = req.body;

        // Get org-level n8n config
        const userStore = require('../../stores/userStore');
        const user = await userStore.getUser(getUserId(req));
        const orgId = user?.organizationId;
        if (!orgId) {
            return res.status(400).json({ error: 'No organization configured' });
        }

        const n8nUrl = await configStore.getConfig(`n8n_url_org_${orgId}`);
        const n8nApiKey = await configStore.getSecret(`n8n_api_key_org_${orgId}`);
        if (!n8nUrl || !n8nApiKey) {
            return res.status(400).json({ error: 'n8n is not configured for your organisation' });
        }

        const orgWorkflows = await configStore.getConfig(`n8n_workflows_org_${orgId}`) || [];
        const configuredWf = orgWorkflows.find(w => w.id === workflowId);
        if (!configuredWf || !configuredWf.allowKbIngestion) {
            return res.status(403).json({ error: 'This n8n workflow has not been enabled for KB ingestion by your Organisation administrator' });
        }

        // Fetch the full workflow definition from n8n
        const { fetchWorkflowById, triggerWebhookWorkflow } = require('../../integrations/n8nTools');
        const workflow = await fetchWorkflowById(n8nUrl, n8nApiKey, workflowId);

        if (!workflow || !workflow.nodes) {
            return res.status(400).json({ error: 'Invalid workflow data received from n8n' });
        }

        let documentsToIngest = [];

        if (mode === 'definition') {
            // Convert Workflow Definition to Markdown
            const { convertN8nWorkflowToMarkdown } = require('../../core/n8nWorkflowConverter');
            const markdown = convertN8nWorkflowToMarkdown(workflow);
            const title = `n8n Workflow Structure: ${workflow.name || 'Untitled'}`;
            const sourceUri = `n8n://workflow/${workflowId}/definition`;
            
            if (!markdown || markdown.trim().length < 10) {
                return res.status(400).json({ error: 'Workflow produced no meaningful content' });
            }
            documentsToIngest.push({ title, markdown, sourceUri });
        } else {
            // Execute Webhook and use Data
            const webhookNode = workflow.nodes.find(n => n.type === 'n8n-nodes-base.webhook');
            if (!webhookNode || !webhookNode.parameters || !webhookNode.parameters.path) {
                return res.status(400).json({ error: 'Execution failed: No active webhook trigger node found in this workflow.' });
            }

            const webhookPath = webhookNode.parameters.path;
            const httpMethod = webhookNode.parameters.httpMethod || 'GET';
            
            log.info(`[KB] Executing n8n workflow webhook for real-time ingestion: ${webhookPath}`);
            const resultContent = await triggerWebhookWorkflow(n8nUrl, webhookPath, httpMethod, null, []);

            let parsedArray = [];
            if (typeof resultContent === 'string') {
                try {
                    const parsed = JSON.parse(resultContent);
                    // Check if it's an error bubble from triggerWebhookWorkflow
                    if (parsed.error && Object.keys(parsed).length === 1) {
                         return res.status(400).json({ error: parsed.error });
                    }
                    parsedArray = Array.isArray(parsed) ? parsed : [parsed];
                } catch (e) {
                    // Pure markdown or text
                    parsedArray = [{ text: resultContent }];
                }
            } else if (typeof resultContent === 'object') {
                if (resultContent.error && Object.keys(resultContent).length === 1) {
                     return res.status(400).json({ error: resultContent.error });
                }
                parsedArray = Array.isArray(resultContent) ? resultContent : [resultContent];
            }

            parsedArray.forEach((item, idx) => {
                let itemMarkdown = item.markdown || item.text || item.content || `\`\`\`json\n${JSON.stringify(item, null, 2)}\n\`\`\``;
                let itemTitle = item.fileName || item.filename || item.title || item.name || `n8n Output: ${workflow.name} (Item ${idx + 1})`;
                documentsToIngest.push({
                    title: itemTitle,
                    markdown: itemMarkdown,
                    sourceUri: itemTitle
                });
            });
        }

        if (documentsToIngest.length === 0) {
            return res.status(400).json({ error: 'n8n workflow executed successfully, but returned no content for the KB' });
        }

        // One source for everything this KB imported from n8n. Kind `legacy`
        // with the original source_type in config — the same shape
        // migrations/kb-sources-backfill.js gives the rows that predate the
        // model, so old and new n8n documents end up on ONE source instead of
        // two that mean the same thing.
        const n8nSource = await ensureKbSource(kb.id, 'legacy', {
            name: 'n8n',
            config: { sourceType: 'n8n' },
            configMatch: { sourceType: 'n8n' },
            createdBy: getUserId(req),
        });

        // Ingest into KB
        let totalChunks = 0;
        let lastResult = null;
        let ingestedDocs = 0;

        for (const doc of documentsToIngest) {
            if (!doc.markdown || doc.markdown.trim().length === 0) continue;

            try {
                const result = await ingestDocument(
                    kb.tenant_id, kb.id, doc.markdown,
                    doc.title, 'n8n', doc.sourceUri,
                    {
                        sourceId: n8nSource ? n8nSource.id : null,
                        externalId: doc.sourceUri || null,
                        createdBy: getUserId(req),
                    }
                );
                totalChunks += result.chunks;
                ingestedDocs++;
                lastResult = result;
            } catch (err) {
                log.error(`[KB] Failed to ingest item ${doc.title}:`, err.message);
                if (documentsToIngest.length === 1) throw err; // Throw if it's the only one
            }
        }

        if (totalChunks === 0) {
            return res.status(400).json({ error: `Execution succeeded, but no chunks were produced. Raw payload extracted from ${documentsToIngest.length} item(s) was not chunkable.` });
        }

        log.info(`[KB] n8n workflow "${workflow.name}" ingested [mode=${mode}]: ${ingestedDocs} docs, ${totalChunks} chunks`);

        res.status(201).json({
            success: true,
            document: lastResult ? lastResult.document : null,
            chunks: totalChunks,
            workflowName: workflow.name,
        });
    } catch (e) {
        if (e.code === 'DUPLICATE') {
            return res.status(409).json({ error: 'This workflow is already imported in this KB', documentId: e.documentId });
        }
        log.error('[KB] n8n ingest error:', e.message);
        next(e);
    }
});
module.exports = router;
