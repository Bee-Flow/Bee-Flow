// @typecheck strict
/**
 * Workflow execution over HTTP: run a workflow graph, run a workflow as a
 * subworkflow.
 *
 * ── What a caller may send ──────────────────────────────────────────
 *
 * Each body is `.strict()` at the top: every key there changes what runs or
 * what is recorded, and each was dropped without a word when misspelled —
 * `workflowID` ran the graph with NO execution record (executionId: null),
 * and `input` in place of `inputData` ran the subworkflow on `{}` and
 * answered `success: true`.
 *
 * The graph itself stays OPEN inside — its nodes and edges are the engine's
 * contract (executionEngine reads them), not this route's. The schema asks
 * only for the two lists the engine walks: without them the run died on a
 * TypeError, as a 500, after the execution record had already been written.
 */

const express = require('express');
const { z, typeError } = require('../utils/zod');
const { worded } = require('../core/http/schemaParts');
const executionEngine = require('../core/executionEngine');
const log = require('../telemetry/log');
const { validate } = require('../core/http/validate');

const router = express.Router();

const { getUserAuth } = require('../utils/routeHelpers');
const { requireAuth } = require('../auth');
const { bestEffort } = require('../utils/bestEffort');
const { sessionUser } = require('../core/http/sessionUser');

const WORKFLOW_TEXT = 'workflow is the graph to run: { nodes: [...], edges: [...] }.';
const Graph = z.object({
    nodes: z.array(z.record(z.string(), z.unknown(), { error: typeError({ invalid: 'Each node is an object.' }) }), { error: WORKFLOW_TEXT }),
    edges: z.array(z.record(z.string(), z.unknown(), { error: typeError({ invalid: 'Each edge is an object.' }) }), { error: WORKFLOW_TEXT }),
}, { error: typeError({ required: WORKFLOW_TEXT, invalid: WORKFLOW_TEXT }) }).passthrough();

const RUN_ID_TEXT = 'workflowId is the id of the saved workflow this run belongs to.';
const ExecuteBody = z.object({
    workflow: Graph,
    workflowId: worded(RUN_ID_TEXT).trim().min(1, RUN_ID_TEXT).optional(),
    workflowName: worded('workflowName is text.').optional(),
}, { error: typeError({ required: WORKFLOW_TEXT, invalid: WORKFLOW_TEXT }) }).strict();

/** A body that also accepts no body at all: Express 5 leaves `req.body` undefined then. */
const SubworkflowBody = z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object({
    // What the subworkflow ENTERS with — its trigger's contract, not this route's.
    inputData: z.unknown().optional(),
    callerId: worded('callerId is text.').trim().max(200, 'callerId is at most 200 characters.').optional(),
}).strict());

// Execute a workflow. Inline requireAuth:
// this runs caller-supplied workflow JSON through components that reach the
// network and the caller's stored credentials, so it must never be reachable
// anonymously.
router.post('/execute', requireAuth, validate({ body: ExecuteBody }), async (req, res, next) => {
    const { workflow, workflowId, workflowName } = req.body;
    const userAuth = await getUserAuth(req);
    // requireAuth guarantees a session user here — the old `|| 'anonymous'`
    // fallback (anonymous execution without a record) can no longer occur.
    const userId = sessionUser(req).id;
    const workflowStore = require('../stores/workflowStore');

    // Create execution record (include workflow structure for visual replay)
    /** @type {string | null} */
    let executionId = null;
    if (workflowId) {
        const execution = await workflowStore.createExecution(workflowId, workflowName || 'Workflow', userId, 'manual', workflow);
        executionId = execution.id;
    }

    try {
        const result = await executionEngine.executeWorkflow(workflow, userAuth);

        // Complete execution record
        if (executionId) {
            const nodesExecuted = Object.keys(result).length;
            await workflowStore.completeExecution(executionId, 'success', nodesExecuted, result);
        }

        res.json({ success: true, result, executionId });
    } catch (error) {
        log.error('Execution failed:', error);

        // Log failed execution
        if (executionId) {
            await workflowStore.completeExecution(executionId, 'failed', 0, null, /** @type {Error} */ (error).message).catch((e) => bestEffort('routes/execute:anon', e));
        }

        next(error);
    }
});

// Execute a workflow as a subworkflow over HTTP. Workflow-to-workflow and
// agent-to-workflow calls run in-process through the execution engine
// (core/agentRuntime/agentTools.js, core/tools/toolExecution.js) and never
// pass through here, so this route only serves signed-in API callers.
router.post('/subworkflow/:workflowId', requireAuth, validate({ body: SubworkflowBody }), async (/** @type {import('express').Request<{ workflowId: string }, any, import('zod').infer<typeof SubworkflowBody>, import('qs').ParsedQs>} */ req, res) => {
    const { workflowId } = req.params;
    const { inputData, callerId } = req.body;
    const userAuth = await getUserAuth(req);
    // requireAuth guarantees a session user — see POST /execute above.
    const userId = sessionUser(req).id;
    const workflowStore = require('../stores/workflowStore');

    // Get the target workflow. getWorkflow scopes by userId (owner,
    // shared-with, or public), so the caller can only run workflows they
    // can see.
    const workflow = await workflowStore.getWorkflow(workflowId, userId);
    if (!workflow) {
        return res.status(404).json({ error: 'Workflow not found' });
    }

    // Check if workflow has a subworkflow trigger
    const hasTrigger = workflow.nodes?.some((/** @type {{ type: string; data: { componentId: string; }; }} */ n) =>
        n.type === 'trigger-subworkflow' ||
        n.data?.componentId === 'trigger-subworkflow'
    );

    if (!hasTrigger) {
        return res.status(400).json({
            error: 'Workflow does not have a Subworkflow Trigger component'
        });
    }

    // Inject trigger metadata into the first trigger node
    const workflowCopy = JSON.parse(JSON.stringify(workflow));
    const triggerNode = workflowCopy.nodes.find((/** @type {{ type: string; data: { componentId: string; }; }} */ n) =>
        n.type === 'trigger-subworkflow' ||
        n.data?.componentId === 'trigger-subworkflow'
    );

    if (triggerNode) {
        triggerNode.data = triggerNode.data || {};
        triggerNode.data.inputValues = {
            ...(triggerNode.data.inputValues || {}),
            inputData: inputData || {},
            _triggerType: 'subworkflow',
            _callerId: callerId || 'api'
        };
    }

    // Create execution record (unconditional now that every caller is a
    // real user)
    const execution = await workflowStore.createExecution(
        workflowId,
        workflow.name || 'Subworkflow',
        userId,
        'subworkflow',
        workflowCopy
    );
    const executionId = execution.id;

    // Execute the workflow
    const result = await executionEngine.executeWorkflow(workflowCopy, userAuth);

    // Log completion
    const nodesExecuted = Object.keys(result).length;
    await workflowStore.completeExecution(executionId, 'success', nodesExecuted, result);

    res.json({ success: true, result, executionId });
});

module.exports = router;
