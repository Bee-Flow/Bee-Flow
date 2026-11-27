// @typecheck strict
/**
 * Registration channels: a first-party module's registrations reach the core's registries at
 * the moment the core file they came from would have made them.
 *
 * Before the split, each registry was filled by a core file (boot/featureModules.js,
 * integrations/toolFamilies.js, integrations/integrationClients.js, ...) when that file loaded,
 * and code that needs a registry loads that file: the server at boot (boot/featureRegistrations.js),
 * the test preload (testUtils/registerFeatures.js) only the cheap getter registries, a test or a
 * script whatever it drives. A module's rows now live in its register() (firstParty/<id>.register.js),
 * which the loader runs once (modules/firstParty/loader.js register). To keep every one of those
 * moments as it was, register() does not call the registry itself: it CONTRIBUTES each group of rows
 * to the channel named after the core file the rows came from, and that core file OPENS its channel
 * when it loads:
 *
 *   contribute(channel, fn)  remember fn; run it now when the channel is open
 *   openChannel(channel)     the core file has loaded (again): run every contribution so far, and
 *                            make sure the modules have registered (registerModules), so that
 *                            requiring a core registration file on its own still fills its
 *                            registry with the modules' rows, as it did when it held them
 *
 * Opening a channel again (a test that clears the core file from require.cache and requires it
 * again) runs its contributions again, exactly as reloading the old file re-ran its lines.
 *
 * registerModules() runs loader.register() once per process. boot/featureRegistrations.js holds it
 * (holdModuleRegistration) while it requires the core files and releases it after, so at boot every
 * module's contributions run inside the loader's failure fence: a contribution that throws marks its
 * module failed. A contribution to a channel that opens later (boot/ports.js wirePorts) runs when it
 * opens and throws like the core line it replaced did.
 *
 * Dependency-free apart from the loader, which it requires only when the modules register.
 */

'use strict';

/** @typedef {{ open: boolean, fns: Array<() => void> }} Channel */

/** @type {Map<string, Channel>} */
const channels = new Map();
let registered = false;
let held = 0;

/**
 * @param {string} name
 * @returns {Channel}
 */
function channelOf(name) {
    if (typeof name !== 'string' || name === '') throw new TypeError('registrationChannels: a channel name is a non-empty string');
    let channel = channels.get(name);
    if (!channel) {
        channel = { open: false, fns: [] };
        channels.set(name, channel);
    }
    return channel;
}

/** Run loader.register() once per process, unless boot is holding it. */
function registerModules() {
    if (registered || held > 0) return;
    registered = true;
    require('./loader').register();
}

/**
 * A module's registrations for the core file `name`: run now when that file has loaded, else when it does.
 * @param {string} name the channel: the tree path of the core file without its extension, e.g. 'boot/featureModules'
 * @param {() => void} fn
 */
function contribute(name, fn) {
    if (typeof fn !== 'function') throw new TypeError(`registrationChannels.contribute(${name}): a contribution is a function`);
    const channel = channelOf(name);
    channel.fns.push(fn);
    if (channel.open) fn();
}

/**
 * The core file `name` has loaded: run what the modules contributed so far, then let them register.
 * @param {string} name
 */
function openChannel(name) {
    const channel = channelOf(name);
    channel.open = true;
    for (const fn of [...channel.fns]) fn();
    registerModules();
}

/**
 * Open the channel `name` unless it is open: for a registry that fills itself on its first miss
 * (core/featureModules.js), so a process that never loaded the core file that opens the channel
 * (a script, the migration runner) still gets the modules' rows.
 * @param {string} name
 */
function ensureOpen(name) {
    if (!channelOf(name).open) openChannel(name);
}

/** Boot: keep registerModules() from running until releaseModuleRegistration(). */
function holdModuleRegistration() {
    held += 1;
}

/** Boot: the core files are loaded; register the modules now (once). */
function releaseModuleRegistration() {
    held = Math.max(0, held - 1);
    registerModules();
}

/**
 * Each channel and how many contributions it holds (tests and diagnostics).
 * @returns {Array<{ name: string, open: boolean, contributions: number }>}
 */
function channelSummary() {
    return [...channels].map(([name, c]) => ({ name, open: c.open, contributions: c.fns.length }));
}

/** Test seam: forget every channel and whether the modules registered. */
function _resetChannelsForTests() {
    channels.clear();
    registered = false;
    held = 0;
}

module.exports = {
    contribute, openChannel, ensureOpen, registerModules, holdModuleRegistration, releaseModuleRegistration, channelSummary, _resetChannelsForTests,
};
