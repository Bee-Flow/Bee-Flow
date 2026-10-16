/** Small readers for parsed WebDAV properties shared by the calendar and tasks tools. */

/** True when current-user-privilege-set lets the user write. */
function hasWritePrivilege(props) {
    const ps = props['current-user-privilege-set'];
    if (!ps) return false;
    const privs = Array.isArray(ps.privilege) ? ps.privilege : (ps.privilege ? [ps.privilege] : []);
    return privs.some((p) => p && (p.write !== undefined || p['write-content'] !== undefined));
}

module.exports = { hasWritePrivilege };
