/**
 * The model's barrel resolves: every name the editor's other layers import
 * from `../model` exists and is the module's own.
 */

import { applyAddNode } from './addNode';
import * as model from './index';
import { NODE_DEFS } from './nodeDefs';
import { buildStepGroups } from './palette';

describe('model barrel', () => {
    it('re-exports the modules, not copies of them', () => {
        expect(model.applyAddNode).toBe(applyAddNode);
        expect(model.NODE_DEFS).toBe(NODE_DEFS);
        expect(model.buildStepGroups).toBe(buildStepGroups);
    });

    it('carries every public family of helpers', () => {
        for (const name of [
            'normalizeDefinitionShape', 'edgeKey', 'applyDeleteNodes', 'flowOrder', 'readRoute', 'parseExprToRows',
            'buildIssuesByStep', 'nodeTypeLabel', 'defaultTriggerLabel', 'formatWaitDuration', 'describeCron',
            'limitSummary', 'humanizeExpression', 'cardChrome', 'graphPositions', 'arrangeDefinition', 'rowLayoutPositions',
            'toolLayoutHeights', 'attachTool', 'commitDraft', 'buildSearchResults', 'mergeStepPatchIntoDefinition',
        ]) {
            expect(typeof (model as Record<string, unknown>)[name]).toBe('function');
        }
    });
});
