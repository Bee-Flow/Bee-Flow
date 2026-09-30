/** Contract readers for /api/templates (server/stores/templateStore.js mapRow). */

import { field, pick, shapeListOf, shapeOf } from '@/core/api/contract';

import type { Template } from '../model/types';

const readParameter = shapeOf({ name: field.str(''), description: field.str('') });

const readTemplateRows: (raw: unknown) => Template[] = shapeListOf({
    id: field.str(''),
    userId: field.str(''),
    name: field.str(''),
    description: field.str(''),
    instructions: field.str(''),
    fileName: field.strOrNull,
    storageKey: field.str(''),
    parameters: field.list(readParameter),
    knowledgeBaseIds: field.strArray,
    createdAt: field.strOrNull,
    updatedAt: field.strOrNull,
});

export function readTemplates(raw: unknown): Template[] {
    return readTemplateRows(pick(raw, 'templates'));
}
