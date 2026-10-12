/**
 * The flow editor's device-side state: the draft store of each open automation,
 * its save pipeline, and the registry that hands the stores out.
 */

export { createDraftStore } from './draftStore';
export { flowletView, scopedDraftStore, scopedOp } from './scopedStore';
export {
    aliasDraftStore,
    draftHolders,
    draftStoreFor,
    flushDraft,
    KEEP_TRYING_MAX_MS,
    newDraftKey,
    peekDraftStore,
    RELEASE_GRACE_MS,
    releaseDraftStore,
    resetDraftRegistry,
    retainDraftStore,
} from './registry';
export { automationIdFor, ensureDraftSaved, UnsavedDraftError } from './ensureSaved';
export {
    autoMapOnConnect,
    loadAutoMapPreference,
    resetAutoMapPreference,
    setAutoMapOnConnect,
    useAutoMapOnConnect,
} from './autoMapPreference';
export { RETRY_DELAYS_MS, SAVE_DELAY_MS } from './saveActions';
export { SaveScheduler, type SaveOutcome, type SchedulerOptions } from './scheduler';
export { classifySaveError, type SaveFailure } from './saveErrors';
export { emptyIssueSources, mergeIssues, NO_ISSUES } from './issues';
export { newFlowSeed, type NewFlowKind, type NewFlowOptions } from './seed';
export type {
    DraftActions,
    DraftData,
    DraftDeps,
    DraftOp,
    DraftOptions,
    DraftState,
    DraftStore,
    IssueSource,
    IssueSources,
    SaveError,
    SaveStatus,
} from './types';
