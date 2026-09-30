/**
 * The battery hint is shown once, on the first recording, and never again.
 *
 * Some Android skins (OnePlus, Oppo, Xiaomi, Samsung) stop background apps
 * with their own battery managers, foreground service or not. The app cannot
 * exempt itself without REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, a permission a
 * privacy product has no business asking for — so it tells the person once,
 * with a way into the app's settings, and leaves the choice with them.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const SEEN_KEY = 'beeflow.recordings.batteryHintSeen.v1';

/**
 * True the first time it is asked (and remembers that it said so). False on
 * every later call, and false when storage cannot answer: a hint that nags
 * because storage is broken is worse than a hint that never shows.
 */
export async function claimBatteryHint(): Promise<boolean> {
    try {
        if (await AsyncStorage.getItem(SEEN_KEY)) return false;
        await AsyncStorage.setItem(SEEN_KEY, new Date().toISOString());
        return true;
    } catch {
        return false;
    }
}
