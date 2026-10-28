/**
 * Jest resolver: the default one, plus a fence around agent-hub.
 *
 * The lockstep tests require() agent-hub modules and run them beside their mobile
 * port. In this package `@/` means mobile/src (moduleNameMapper in jest.config.js);
 * in agent-hub it means agent-hub/src. An agent-hub file that imports `@/…` would
 * therefore resolve to a different file here, or to none, and a mobile file that
 * happens to share the path would load silently. So an agent-hub file that mobile
 * executes keeps relative imports, and this resolver says so when one does not.
 * The list of those files is scripts/deep-imports.exclude.json.
 */
/* global __dirname */
const path = require('path');

const AGENT_HUB_SRC = path.resolve(__dirname, '..', 'agent-hub', 'src') + path.sep;
const MOBILE_SRC = path.resolve(__dirname, 'src') + path.sep;

module.exports = (request, options) => {
    const from = options.basedir ? options.basedir + path.sep : '';
    if (from.startsWith(AGENT_HUB_SRC) && path.isAbsolute(request) && request.startsWith(MOBILE_SRC)) {
        // jest wraps an error thrown here in "Could not locate module", so say why first.
        const why =
            `An agent-hub file (${path.relative(path.resolve(__dirname, '..'), options.basedir)}) imports "@/…", which jest here maps to mobile/src (${request}). ` +
            'Keep relative imports in agent-hub files that mobile executes and list the file in scripts/deep-imports.exclude.json.';
        console.error(why);
        throw new Error(why);
    }
    return options.defaultResolver(request, options);
};
