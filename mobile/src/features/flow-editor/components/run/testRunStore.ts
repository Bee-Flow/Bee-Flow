/**
 * The last test run of each open automation, shared by every screen that shows
 * it: the build screen's outline and canvas, and the step editor pushed over
 * them. A test started in the step editor colours the cards when the author
 * comes back, and a dry run started from the toolbar gives the step editor
 * real upstream output — as the web builder's one builder state does.
 *
 * One vanilla zustand store per automation (keyed like the draft store: the
 * automation id, or a new automation's draft key), kept for the session: a test
 * run is a few rows, and seeing the last one again on reopening an automation
 * is the point.
 */

import { createStore, type StoreApi } from 'zustand/vanilla';

import type { StepRunMode, StepRunResult } from '@/features/flow-editor/api';

import { beginRun, IDLE_TEST_RUN, settleStepRun, type TestRunState } from './runState';

export type TestRunStore = StoreApi<TestRunState>;

const stores = new Map<string, TestRunStore>();

export function testRunStoreFor(key: string): TestRunStore {
    let store = stores.get(key);
    if (!store) {
        store = createStore<TestRunState>()(() => IDLE_TEST_RUN);
        stores.set(key, store);
    }
    return store;
}

/**
 * A new automation got its id: its run is found under the id too, as its draft
 * store is (state/registry aliasDraftStore). The screen that hands over to
 * the automation's own route reads the id's store — without this, the first
 * test run (which is what created the automation) vanished with the old key.
 */
export function aliasTestRunStore(key: string, alias: string): void {
    if (key !== alias && !stores.has(alias)) stores.set(alias, testRunStoreFor(key));
}

/** Change an automation's test run with one of runState.ts's transitions. */
export function updateTestRun(key: string, change: (state: TestRunState) => TestRunState): void {
    const store = testRunStoreFor(key);
    store.setState(change(store.getState()), true);
}

/**
 * A step run another screen made and read itself (the step editor's Test):
 * recorded here too, so the cards show it and the next step's variables see
 * its output.
 */
export function recordStepRun(key: string, stepId: string, mode: StepRunMode, result: StepRunResult): void {
    const now = Date.now();
    updateTestRun(key, (s) => settleStepRun(beginRun(s, { kind: 'step', stepId, mode, now }), result, now));
}

/** Tests only: forget every automation's run. */
export function resetTestRunStores(): void {
    stores.clear();
}
