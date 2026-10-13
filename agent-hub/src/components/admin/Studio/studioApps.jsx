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
export { STUDIO_APPS, STUDIO_ICONS, default } from './studioRegistry';
export {
    makeCanUse, STUDIO_CATEGORIES, DEFAULT_STUDIO_CATEGORY, groupStudioApps, resolveStudioNav,
    studioPermissionHeld, firstOpenStudioSection, studioLockHint, studioTrainingArea, createFormAutomation,
} from './studioGates';

export async function createAutomationDraft(ctx, options) {
    const { createAutomationDraft: create } = await import('../../../api/queries/automation/createDraft');
    return create(ctx, options);
}
