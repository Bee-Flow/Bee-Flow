// @typecheck strict
/**
 * The registrations of the first-party module "meetingNotes": its rows of the core's registries,
 * each group contributed to the channel of the core file that registers
 * that kind of row (modules/firstParty/registrationChannels.js), so it runs when that file loads.
 * The names it provides are in firstParty/meetingNotes.provides.json.
 */

'use strict';

const { contribute } = require('../modules/firstParty/registrationChannels');

function register() {
    contribute('boot/featureModules', () => require('../core/featureModules').registerFeatureModules({
        // what the core asks of this module by name (optionalFeatureModule): one getter per line
        'stores/transcriptionStore': () => require('../stores/transcriptionStore'),
        'stores/transcriptCrypto': () => require('../stores/transcriptCrypto'),
        'routes/transcriptions/shared': () => require('../routes/transcriptions/shared'),
    }));
    contribute('boot/featureRegistrations', () => require('../core/meetingNotes/runnerPorts'));
    contribute('integrations/toolFamilies', () => {
        const { isTranscriptionTool, executeTranscriptionTool } = require('../integrations/transcriptionTools');
        require('../integrations/toolFamilyAdapters').registerFamilies([
            { name: 'transcription', order: 580, isTool: isTranscriptionTool, execute: (n, a, ctx) => executeTranscriptionTool(n, a, { userId: ctx.userId, session: ctx.session, attachments: ctx.attachments, req: ctx.req }) },
        ]);
    });
    contribute('integrations/coreToolsets', () => require('../integrations/coreToolsets').registerToolsets({
        TRANSCRIPTION_TOOLS: require('../integrations/transcriptionTools').TRANSCRIPTION_TOOLS,
    }));
}

module.exports = { register };
