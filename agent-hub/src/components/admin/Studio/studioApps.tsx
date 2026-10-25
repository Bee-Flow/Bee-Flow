// Compatibility re-export. The Studio registry was split in three:
//
//   studioRegistry.tsx  STUDIO_APPS (+ default), STUDIO_ICONS — the section
//                       list and its lazy imports
//   studioGates.ts      the gates, lock hints, categories and
//                       createFormAutomation — what a section's own files need
//   api/queries/automation/createDraft.ts
//                       createAutomationDraft, the POST
//
// Everything that imported './studioApps' keeps working through this file.
// A file under a section's folder (Studio/*/) must not: it imports
// studioGates.ts or createDraft.ts directly, because this file re-exports the
// registry and the registry lazy-imports every section
// (studioRegistry.boundary.test.ts).
//
// Same import discipline as the registry: this file is in the main chunk, so
// the API module is import()ed at call time, never re-exported statically.
import type { AutomationDraftCtx, AutomationDraftOptions } from '../../../api/queries/automation/createDraft';
export { STUDIO_APPS, STUDIO_ICONS,  } from './studioRegistry';
export {
    makeCanUse, STUDIO_CATEGORIES, DEFAULT_STUDIO_CATEGORY, groupStudioApps, resolveStudioNav,
    studioPermissionHeld, firstOpenStudioSection, studioLockHint,  createFormAutomation,
} from './studioGates';

export async function createAutomationDraft(ctx: AutomationDraftCtx, options?: AutomationDraftOptions) {
    const { createAutomationDraft: create } = await import('../../../api/queries/automation/createDraft');
    return create(ctx, options);
}
