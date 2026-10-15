/**
 * Ports: a lower layer declares the hook, the layer that owns the policy
 * fills it in at boot. Each line here would otherwise be an upward import.
 *
 *  - stores/agent/tokenDisplay: a reopened conversation restores its Privacy
 *    Shield tokens through core/dlp/dlpRunner, the one module that decrypts a
 *    stored token map. Without it a reopened chat shows its placeholders.
 *  - core/automationRunner/documentMarking (Art. 50(2)): core owns the port,
 *    compliance owns the policy. Without it a generated document renders
 *    unmarked.
 */

'use strict';

/** @param {{ compliance: boolean }} available  which optional modules are installed */
function wirePorts({ compliance }) {
    require('../stores/agent/tokenDisplay').setTokenMapReader(require('../core/dlp/dlpRunner').getConversationTokenMapAsync);
    if (compliance) {
        require('../core/automationRunner/documentMarking')
            .setMarkingResolver((orgId, info) => require('../compliance/marking').resolveMarking(orgId, info));
    }
}

module.exports = { wirePorts };
