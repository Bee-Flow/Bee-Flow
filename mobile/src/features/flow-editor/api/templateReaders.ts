/**
 * Contract readers for the template gallery (routes/automation/crud.js over
 * automation/templates.js) and the ai_step's agent capsule
 * (routes/automation/catalog.js GET /catalog/agent/:agentId).
 */

import { field, nullable, pick, shapeListOf, shapeOf } from '@/core/api/contract';

import type { AgentPreview, FlowTemplate, FlowTemplateList, FlowTemplateSummary } from './types';
import { asDefinition } from '../model/normalize';

/** listTemplates + deriveTemplateMeta: a card, without the definition. */
const readTemplateRows: (raw: unknown) => FlowTemplateSummary[] = shapeListOf({
    id: field.str(''),
    title: field.str(''),
    description: field.str(''),
    category: field.str(''),
    icon: field.strOrNull,
    tags: field.strArray,
    requiredIntegrations: field.strArray,
    triggerReadiness: field.str('ready'),
});

export function readTemplateList(raw: unknown): FlowTemplateList {
    return {
        templates: readTemplateRows(pick(raw, 'templates')).filter((t) => t.id !== ''),
        categories: field.strArray(pick(raw, 'categories')),
    };
}

/** getTemplate: the whole template, definition included. */
const readTemplate: (raw: unknown) => FlowTemplate = shapeOf({
    id: field.str(''),
    title: field.str(''),
    description: field.str(''),
    category: field.str(''),
    icon: field.strOrNull,
    tags: field.strArray,
    definition: asDefinition,
});

export function readTemplateResponse(raw: unknown): FlowTemplate | null {
    return nullable(readTemplate)(pick(raw, 'template'));
}

const readWithheld = shapeListOf({ name: field.str(''), reason: field.str('unavailable') });

/**
 * What an agent would bring to this ai_step. A refusal (deleted, unpublished,
 * another organisation) is one undifferentiated `canUse: false` on purpose.
 */
export const readAgentPreview: (raw: unknown) => AgentPreview = shapeOf({
    id: field.str(''),
    canUse: field.bool(false),
    name: field.strOrNull,
    runtimeSource: field.strOrNull,
    permissions: field.record<Record<string, unknown>>({}),
    allowed: field.strArray,
    withheld: (v: unknown) => readWithheld(v).filter((w) => w.name !== ''),
    degraded: field.bool(false),
    error: field.strOrNull,
});
