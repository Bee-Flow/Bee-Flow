/** A new routine's test run is found under its id once it has one. */

import { IDLE_TEST_RUN } from './runState';
import { aliasTestRunStore, resetTestRunStores, testRunStoreFor, updateTestRun } from './testRunStore';

afterEach(() => resetTestRunStores());

describe('aliasTestRunStore', () => {
    it('hands the draft key’s run to the new id, and later updates reach both', () => {
        updateTestRun('new:1', (s) => ({ ...s, pending: true, runId: 'r1' }));
        aliasTestRunStore('new:1', 'a1');
        expect(testRunStoreFor('a1')).toBe(testRunStoreFor('new:1'));
        expect(testRunStoreFor('a1').getState()).toMatchObject({ pending: true, runId: 'r1' });
        updateTestRun('new:1', () => IDLE_TEST_RUN);
        expect(testRunStoreFor('a1').getState()).toBe(IDLE_TEST_RUN);
    });

    it('never replaces a run the id already has', () => {
        updateTestRun('a1', (s) => ({ ...s, runId: 'kept' }));
        aliasTestRunStore('new:2', 'a1');
        expect(testRunStoreFor('a1').getState().runId).toBe('kept');
    });
});
