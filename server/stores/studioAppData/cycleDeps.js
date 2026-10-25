// @typecheck strict
/**
 * The three collaborators of studioAppDataStore that sit in the server's big
 * import cycle: the data-model contract (../../appStudio/dataModel), the
 * per-app engine (../studioAppDbStore) and the FK parent's store
 * (../studioAppStore). The barrel (../studioAppDataStore.js) is the one place
 * that requires them and hands them in here, so the parts of the store stay
 * out of that cycle. The parts read them at call time.
 *
 * @type {{ dataModel: any, studioAppDbStore: any, studioAppStore: any }}
 */
const deps = { dataModel: null, studioAppDbStore: null, studioAppStore: null };

/** @param {{ dataModel: any, studioAppDbStore: any, studioAppStore: any }} d */
function bindCycleDeps(d) {
    deps.dataModel = d.dataModel;
    deps.studioAppDbStore = d.studioAppDbStore;
    deps.studioAppStore = d.studioAppStore;
}

module.exports = { deps, bindCycleDeps };
