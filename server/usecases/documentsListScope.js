// @typecheck strict
/**
 * Who may list the shared generated-documents directory.
 *
 * The directory keeps no owner per file. With one organisation it is a shared
 * folder; with several, listing it would show one organisation's files to
 * another, so there only the platform admin lists it.
 */

/** Replaceable in tests: the route has no database of its own. */
const ports = {
    /** @returns {Promise<number>} */
    organizationCount: async () => (await require('../stores/userStore').getAllOrganizations()).length,
};

/**
 * @param {{ isAdmin?: boolean, user?: { role?: string } | null } | null | undefined} session
 * @returns {Promise<boolean>}
 */
async function mayListSharedDocuments(session) {
    if (session?.isAdmin || session?.user?.role === 'admin') return true;
    return (await ports.organizationCount()) <= 1;
}

module.exports = { mayListSharedDocuments, ports };
