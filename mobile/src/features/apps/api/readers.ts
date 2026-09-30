/**
 * Contract readers for Studio apps. The component tree and the viewer record
 * pass through as objects — the renderer (model/appDefinition.ts) tolerates
 * gaps inside them node by node.
 */

import { field, shapeOf } from '@/core/api/contract';

import type { AppActionResult, AppDefinition, StudioAppMeta, StudioAppRuntime } from '../model/types';

export const readStudioApp: (raw: unknown) => StudioAppMeta = shapeOf({
    id: field.str(''),
    userId: field.str(''),
    organizationId: field.strOrNull,
    projectId: field.strOrNull,
    name: field.str('Untitled app'),
    description: field.str(''),
    icon: field.strOrNull,
    accentColor: field.strOrNull,
    definitionVersion: field.num(0),
    publishedVersion: field.numOrNull,
    isPublished: field.bool(false),
    publishedAt: field.strOrNull,
    createdAt: field.strOrNull,
    updatedAt: field.strOrNull,
});

export const readAppRuntime: (raw: unknown) => StudioAppRuntime = shapeOf({
    id: field.str(''),
    name: field.str('Untitled app'),
    icon: field.strOrNull,
    accentColor: field.strOrNull,
    definition: field.record<AppDefinition>({}),
    viewer: field.record<StudioAppRuntime['viewer']>({}),
    appVersion: field.numOrNull,
    draft: field.optBool,
});

export const readAppActionResult: (raw: unknown) => AppActionResult = shapeOf({
    runId: field.strOrNull,
    status: field.optStr,
    output: field.raw,
    error: field.strOrNull,
    message: field.optStr,
    approvalId: field.optStr,
});
