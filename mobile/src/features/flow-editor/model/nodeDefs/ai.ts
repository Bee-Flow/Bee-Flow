/**
 * The AI family: the AI step, and data extraction (its own type: one admin-set
 * model, a schema it cannot wander from).
 *
 * Data copied from the web builder's flow/nodeDefs.js; nodeDefs.lockstep.test.ts
 * requires the web module and compares every record, so a changed word fails.
 * The palette wording is `labelFallback` here (the English under the
 * `automations.node.<type>.label` key; ./index.ts serves it as `label`), and a
 * quoted issue-map key is a validation path segment, not copy.
 */

import { FLAT, type NodeDefSource } from './types';

export const AI_DEFS: Record<string, NodeDefSource> = {
    ai_step: {
        family: 'ai',
        typeLabel: 'AI step',
        defaultLabel: 'AI step',
        desc: 'Reason and call tools with AI',
        help: 'Hands the run to an AI model with your instructions, and passes on what it produces.',
        sectionKeys: ['agent', 'inputs', 'advanced', 'output'],
        simpleSections: ['agent', 'inputs'],
        issueSections: {
            fallback: 'advanced',
            map: {
                label: FLAT,
                prompt: FLAT,
                systemPrompt: 'advanced',
                model: 'advanced',
                modelTier: 'advanced',
                allowTools: 'advanced',
                useMemory: 'advanced',
                inputs: 'inputs',
                outputFields: 'output',
                forEach: 'advanced',
                agentId: 'agent',
                skillIds: 'agent',
                agentPermissions: 'agent',
            },
        },
        labelFallback: 'AI step',
    },
    data_extraction: {
        family: 'ai',
        typeLabel: 'Extract data',
        defaultLabel: 'Extract data',
        desc: 'Pull named fields out of text — an invoice, an e-mail, a PDF',
        help: 'Reads a piece of text an earlier step produced and pulls out the fields you name — a date, an amount, a customer — as one tidy record the next steps can use.',
        sectionKeys: ['source', 'fields', 'instructions', 'advanced'],
        simpleSections: ['source', 'fields', 'instructions'],
        issueSections: {
            fallback: 'fields',
            map: { label: FLAT, source: 'source', fields: 'fields', instructions: 'instructions', forEach: 'advanced' },
        },
        labelFallback: 'Extract data',
    },
};
