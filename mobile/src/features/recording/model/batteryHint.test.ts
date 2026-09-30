/**
 * The battery hint shows on the first recording and never again, and says
 * nothing when storage cannot tell whether it already did.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import { claimBatteryHint } from './batteryHint';

beforeEach(async () => {
    await AsyncStorage.clear();
});

describe('claimBatteryHint', () => {
    it('answers yes once, then no', async () => {
        expect(await claimBatteryHint()).toBe(true);
        expect(await claimBatteryHint()).toBe(false);
        expect(await claimBatteryHint()).toBe(false);
    });

    it('stays quiet when storage fails', async () => {
        jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk'));
        expect(await claimBatteryHint()).toBe(false);
    });
});
