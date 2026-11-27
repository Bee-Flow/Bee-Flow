// @typecheck strict
/**
 * Ports: a lower layer declares the hook, the layer that owns the policy
 * fills it in at boot. Each line here would otherwise be an upward import.
 *
 *  - stores/agent/tokenDisplay: a reopened conversation restores its Privacy
 *    Shield tokens through core/dlp/dlpRunner, the one module that decrypts a
 *    stored token map. Without it a reopened chat shows its placeholders.
 *
 * A port whose policy belongs to a first-party module is filled in that
 * module's firstParty/<id>.register.js, contributed to the channel 'boot/ports'
 * (modules/firstParty/registrationChannels.js) that wirePorts opens, so it is
 * wired when wirePorts runs:
 *
 *  - core/automationRunner/documentMarking (Art. 50(2)): core owns the port,
 *    compliance owns the policy (firstParty/compliance.register.js). Without
 *    it, or without the compliance module, a generated document renders unmarked.
 */

'use strict';

/**
 * @param {{ compliance?: boolean }} [_available]  which optional modules are installed; not read: a module that
 *   is not available does not register (the parameter keeps boot/startupJobs.js's call valid)
 */
function wirePorts(_available) {
    require('../stores/agent/tokenDisplay').setTokenMapReader(require('../core/dlp/dlpRunner').getConversationTokenMapAsync);
    require('../modules/firstParty/registrationChannels').openChannel('boot/ports');
}

module.exports = { wirePorts };
