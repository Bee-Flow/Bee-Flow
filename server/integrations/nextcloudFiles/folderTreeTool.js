// @typecheck strict
/** Schema of nextcloud_folder_tree (own file: toolDefinitions.js is at its size ceiling). */

const FOLDER_TREE_TOOL = {
    type: 'function',
    function: {
        name: 'nextcloud_folder_tree',
        description: 'Get a nested tree of the user\'s folders in one call — much cheaper than walking list_files level by level when you need an overview of where things live.',
        parameters: {
            type: 'object',
            properties: {
                depth: { type: 'integer', description: 'How many levels deep to descend (default 3, max 10).' },
                path: { type: 'string', description: 'Folder to start from (default: the root).' },
                withParents: { type: 'boolean', description: 'Also include the parent folders of the starting path.' }
            }
        }
    }
};

module.exports = { FOLDER_TREE_TOOL };
