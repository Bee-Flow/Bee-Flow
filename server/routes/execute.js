/**
 * Workflow execution over HTTP: run a workflow graph, test one component, run
 * a workflow as a subworkflow.
 *
 * ── What a caller may send ──────────────────────────────────────────
 *
 * Each body is `.strict()` at the top: every key there changes what runs or
 * what is recorded, and each was dropped without a word when misspelled —
 * `workflowID` ran the graph with NO execution record (executionId: null),
 * and `input` in place of `inputData` ran the subworkflow on `{}` and
 * answered `success: true`. A test run's `inputs` given as text or a list
 * was spread character by character into `{ 0: …, 1: … }` and handed to the
 * component as its input values.
 *
 * The graph itself stays OPEN inside — its nodes and edges are the engine's
 * contract (executionEngine reads them), not this route's. The schema asks
 * only for the two lists the engine walks: without them the run died on a
 * TypeError, as a 500, after the execution record had already been written.
 */

const express = require('express');
const { z } = require('zod');
const executionEngine = require('../core/executionEngine');
const componentManager = require('../core/cms/componentManager');
const log = require('../telemetry/log');
const { validate } = require('../core/http/validate');

const router = express.Router();

const { getUserAuth } = require('../utils/routeHelpers');
const { requireAuth } = require('../auth');

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

const WORKFLOW_TEXT = 'workflow is the graph to run: { nodes: [...], edges: [...] }.';
const Graph = z.object({
    nodes: z.array(z.record(z.unknown(), { invalid_type_error: 'Each node is an object.' }), { required_error: WORKFLOW_TEXT, invalid_type_error: WORKFLOW_TEXT }),
    edges: z.array(z.record(z.unknown(), { invalid_type_error: 'Each edge is an object.' }), { required_error: WORKFLOW_TEXT, invalid_type_error: WORKFLOW_TEXT }),
}, { required_error: WORKFLOW_TEXT, invalid_type_error: WORKFLOW_TEXT }).passthrough();

const RUN_ID_TEXT = 'workflowId is the id of the saved workflow this run belongs to.';
const ExecuteBody = z.object({
    workflow: Graph,
    workflowId: worded(RUN_ID_TEXT).trim().min(1, RUN_ID_TEXT).optional(),
    workflowName: worded('workflowName is text.').optional(),
}, { required_error: WORKFLOW_TEXT, invalid_type_error: WORKFLOW_TEXT }).strict();

const COMPONENT_TEXT = 'componentId is required';
const INPUTS_TEXT = 'inputs is an object of input values, like { "input": "hello" }.';
const TestComponentBody = z.object({
    componentId: worded(COMPONENT_TEXT).trim().min(1, COMPONENT_TEXT),
    inputs: z.record(z.unknown(), { invalid_type_error: INPUTS_TEXT }).nullish(),
}, { required_error: COMPONENT_TEXT, invalid_type_error: COMPONENT_TEXT }).strict();

/** A body that also accepts no body at all: Express 5 leaves `req.body` undefined then. */
const SubworkflowBody = z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object({
    // What the subworkflow ENTERS with — its trigger's contract, not this route's.
    inputData: z.unknown().optional(),
    callerId: worded('callerId is text.').trim().max(200, 'callerId is at most 200 characters.').optional(),
}).strict());

// Execute a workflow. Inline requireAuth (same idiom as routes/ai/agentChat.js):
// this runs caller-supplied workflow JSON through components that reach the
// network and the caller's stored credentials, so it must never be reachable
// anonymously.
router.post('/execute', requireAuth, validate({ body: ExecuteBody }), async (req, res, next) => {
    const { workflow, workflowId, workflowName } = req.body;
    const userAuth = await getUserAuth(req);
    // requireAuth guarantees a session user here — the old `|| 'anonymous'`
    // fallback (anonymous execution without a record) can no longer occur.
    const userId = req.session.user.id;
    const workflowStore = require('../stores/workflowStore');

    // Create execution record (include workflow structure for visual replay)
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
            await workflowStore.completeExecution(executionId, 'failed', 0, null, error.message).catch(() => { });
        }

        next(error);
    }
});

// Test a single component with sample inputs — the Component Studio's test
// runner. Component execution, so gated like POST /execute.
router.post('/test-component', requireAuth, validate({ body: TestComponentBody }), async (req, res) => {
    const { componentId, inputs } = req.body;

    const components = componentManager.getComponents();
    const component = components.find(c => c.id === componentId);

    if (!component) {
        return res.status(404).json({ error: `Component '${componentId}' not found` });
    }

    const userAuth = await getUserAuth(req);

    const testWorkflow = {
        nodes: [{
            id: 'test-node',
            type: 'custom',
            data: {
                componentId: componentId,
                inputValues: inputs || {}
            }
        }],
        edges: []
    };

    const result = await executionEngine.executeWorkflow(testWorkflow, userAuth);
    const nodeResult = result['test-node'];
    res.json(nodeResult || { output: 'No output' });
});

// Execute a workflow as a subworkflow over HTTP. Workflow-to-workflow and
// agent-to-workflow calls run in-process through the execution engine
// (core/agentRuntime/agentTools.js, core/tools/toolExecution.js) and never
// pass through here, so this route only serves signed-in API callers.
router.post('/subworkflow/:workflowId', requireAuth, validate({ body: SubworkflowBody }), async (req, res) => {
    const { workflowId } = req.params;
    const { inputData, callerId } = req.body;
    const userAuth = await getUserAuth(req);
    // requireAuth guarantees a session user — see POST /execute above.
    const userId = req.session.user.id;
    const workflowStore = require('../stores/workflowStore');

    // Get the target workflow. getWorkflow scopes by userId (owner,
    // shared-with, or public), so the caller can only run workflows they
    // can see.
    const workflow = await workflowStore.getWorkflow(workflowId, userId);
    if (!workflow) {
        return res.status(404).json({ error: 'Workflow not found' });
    }

    // Check if workflow has a subworkflow trigger
    const hasTrigger = workflow.nodes?.some(n =>
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
    const triggerNode = workflowCopy.nodes.find(n =>
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
