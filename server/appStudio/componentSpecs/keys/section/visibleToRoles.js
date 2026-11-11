'use strict';
// @typecheck strict

module.exports = {
    since: 3,
    shape: 'string[] (role keys of definition.roles)',
    description: 'Shows the section only to viewers who hold one of these app roles. '
        + 'Same rule as screen.visibleToRoles and node.visibleToRoles: an empty list is open to everyone, the owner always sees it. '
        + 'A section hidden from a role renders nothing for that role, its data is not loaded and the buttons inside it are refused by the server for that role. '
        + 'Row-level access still comes from the table rules, so this is about what a role is shown, not what it may read. '
        + 'Set it with app_update_section {sectionId, visibleToRoles: ["manager"]}; [] or null removes it.',
};
