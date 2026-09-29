/**
 * Component Designer — create, read, update and delete the components under
 * components/, the directories executionEngine spawns.
 *
 * ── What a caller may send ──────────────────────────────────────────
 *
 * Both bodies are `.strict()` and typed. Before, three things were answered
 * "Component created/updated successfully" while something else happened:
 *
 *   - a dependency NOT on componentManager's allow-list was written to
 *     package.json, refused by installDependencies (a log line nobody reads),
 *     and the component then died at run time on "Cannot find module". The
 *     schema now refuses it by name, before anything is written;
 *   - the allow-list checks the NAME, and npm installs whatever the VERSION
 *     points at: `{ axios: 'https://…/x.tgz' }`, `'git+https://…'`,
 *     `'file:../…'` or `'npm:other@1'` put an unvetted package — and its
 *     install scripts — on the host under a vetted name. A version is now a
 *     registry range or tag, never a location;
 *   - `agentEnabled: 'true'` (the string) was stored as a string; the studio
 *     shows it as on (`!== false`), the agent tools read `=== true` and never
 *     offer the component. A secure input's `secrue: true` was stored and the
 *     secret default then went back to every reader of GET /:id, unredacted.
 *
 * `inputs`, `outputs` and `sampleOutput` stay open in their VALUES — they are
 * the author's own contract with the model — but not in their shape.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { z } = require('zod');
const componentManager = require('../core/cms/componentManager');
const { requireAuth } = require('../auth/permissions');
const { validate } = require('../core/http/validate');

const router = express.Router();
const COMPONENTS_DIR = path.resolve(__dirname, '../../components');

// AUTH. The mount (index.js) only wraps this router in
// `requireCapability('component_designer')`, and that gate opens with
// `if (!req.session?.isAuthenticated) return next();` — it deliberately defers
// anonymous callers to "the auth middleware", which was never mounted here. So
// every route below used to be reachable with no session at all: read the
// source and config of every installed component, overwrite a trusted
// component's index.js, recursively delete directories, and drive
// componentManager.installComponent → `npm install` with body-supplied
// dependencies. requireAuth supplies the missing half of that pair; the
// capability gate still decides *which* authenticated users get through.
router.use(requireAuth);

// Component ids are used as directory names under COMPONENTS_DIR. POST / has
// always validated the shape; the :id routes did not, and Express decodes %2F
// inside a single path param — so `DELETE /components/..%2F..%2Fsomewhere`
// produced a componentDir outside the tree and fs.rm(recursive, force) removed
// it. Validate the shape AND assert containment, so neither a traversal nor a
// symlinked/oddly-normalised id can leave COMPONENTS_DIR.
const COMPONENT_ID_RE = /^[a-z0-9-]+$/;
const INVALID_ID_MESSAGE = 'Invalid component ID. Use lowercase letters, numbers, and hyphens only.';

function resolveComponentDir(id) {
    if (typeof id !== 'string' || !COMPONENT_ID_RE.test(id)) return null;
    const dir = path.resolve(COMPONENTS_DIR, id);
    if (dir === COMPONENTS_DIR || !dir.startsWith(COMPONENTS_DIR + path.sep)) return null;
    return dir;
}

// ── The body schemas ────────────────────────────────────────────────
//
// The id's SHAPE stays judged by resolveComponentDir above — one place, with
// the containment check the :id routes need too. The schema asks only that
// it be text.

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

const INPUT_TEXT = 'Each input is a type name, or { type, default, description, secure }.';
const InputDef = z.union([
    worded(INPUT_TEXT),
    z.object({
        type: worded('An input\'s type is text, like "string".').optional(),
        default: z.unknown().optional(),
        description: worded('An input\'s description is text.').optional(),
        secure: z.boolean({ invalid_type_error: 'An input\'s secure flag is true or false.' }).optional(),
        // The studio's placeholder for "a secret is stored, keep it" (see PUT).
        _hasStoredValue: z.boolean().optional(),
    }).strict(),
], { errorMap: () => ({ message: INPUT_TEXT }) });

const OUTPUTS_TEXT = 'outputs maps each output to a type name, like { "result": "string" }.';

/**
 * A registry version range or dist-tag — never a location. npm installs what a
 * spec POINTS AT, so a URL, a git remote, `file:`, a path or an `npm:` alias
 * would put a package nobody vetted on the host under a vetted name. None of
 * those can be written without ':' or '/', and a leading '.' is a path too.
 * One location needs neither: npm reads a spec that ENDS in .tgz, .tar or
 * .tar.gz as a tarball next to package.json (npm-package-arg's `isFileType`,
 * copied here as it is written there), so `evil.tgz` is refused as well.
 */
const VERSION_RE = /^(?![.])(?!.*[.](?:tgz|tar.gz|tar)$)[0-9A-Za-z.\-+^~<>=| *]{1,64}$/i;
const VERSION_TEXT = 'A dependency version is a registry range or tag, like ^1.6.0 or latest — not a URL, git remote or path.';

/** The allow-list is componentManager's; a package off it is refused here, before anything is written. */
const allowedDependencies = () => componentManager.ALLOWED_DEPENDENCIES || new Set();
const Dependencies = z.record(
    z.string().refine((name) => allowedDependencies().has(name), (name) => ({
        message: `"${name}" is not a package a component may install (allowed: ${[...allowedDependencies()].join(', ')}).`,
    })),
    worded(VERSION_TEXT).regex(VERSION_RE, VERSION_TEXT),
    { invalid_type_error: 'dependencies maps package names to versions, like { "axios": "^1.6.0" }.' },
);

const flag = (name) => z.boolean({ invalid_type_error: `${name} is true or false.` });

const COMPONENT_FIELDS = {
    name: worded('A component name is text.').optional(),
    description: worded('A description is text.').optional(),
    category: worded('A category is text.').optional(),
    inputs: z.record(InputDef, { invalid_type_error: 'inputs maps each input name to its definition.' }).optional(),
    outputs: z.record(worded(OUTPUTS_TEXT), { invalid_type_error: OUTPUTS_TEXT }).optional(),
    code: worded('code is the component\'s source, as text.').optional(),
    dependencies: Dependencies.optional(),
    agentEnabled: flag('agentEnabled').optional(),
    directChatEnabled: flag('directChatEnabled').optional(),
};

const BODY_TEXT = 'Send the component as an object.';
const CreateComponentBody = z.object({
    id: worded(INVALID_ID_MESSAGE),
    ...COMPONENT_FIELDS,
}, { required_error: BODY_TEXT, invalid_type_error: BODY_TEXT }).strict();

const UpdateComponentBody = z.object({
    // The studio sends the whole form back, id included; the address decides.
    id: worded(INVALID_ID_MESSAGE).optional(),
    ...COMPONENT_FIELDS,
    aiContext: worded('aiContext is text.').nullish(),
    // Whatever the last test run returned — the studio's "save as sample".
    sampleOutput: z.unknown().optional(),
}, { required_error: BODY_TEXT, invalid_type_error: BODY_TEXT }).strict();

// List all components
router.get('/', (req, res) => {
    res.json(componentManager.getComponents());
});

// Create a new component
router.post('/', validate({ body: CreateComponentBody }), async (req, res) => {
    const { id, name, description, category, inputs, outputs, code, dependencies, agentEnabled, directChatEnabled } = req.body;

        const componentDir = resolveComponentDir(id);
        if (!componentDir) {
            return res.status(400).json({ error: INVALID_ID_MESSAGE });
        }

        if (fs.existsSync(componentDir)) {
            return res.status(400).json({ error: 'Component with this ID already exists.' });
        }

        // Create component directory
        await fs.promises.mkdir(componentDir, { recursive: true });

        // Create component.json
        const componentJson = {
            name: name || id,
            description: description || '',
            category: category || 'Custom',
            inputs: inputs || {},
            outputs: outputs || { result: 'any' },
            agentEnabled: agentEnabled !== undefined ? agentEnabled : true,
            directChatEnabled: directChatEnabled === true
        };
        await fs.promises.writeFile(path.join(componentDir, 'component.json'), JSON.stringify(componentJson, null, 2));

        // Create package.json
        const packageJson = {
            name: id,
            version: '1.0.0',
            dependencies: dependencies || {}
        };
        await fs.promises.writeFile(path.join(componentDir, 'package.json'), JSON.stringify(packageJson, null, 2));

        // Create index.js
        const defaultCode = code || `// ${name || id} Component
// Reads JSON input from stdin, outputs JSON to stdout

let inputData = '';
process.stdin.on('data', chunk => {
    inputData += chunk;
});

process.stdin.on('end', () => {
    try {
        const inputs = JSON.parse(inputData);
        
        // Your component logic here
        const result = {
            message: 'Hello from ${name || id}!',
            receivedInputs: inputs
        };
        
        console.log(JSON.stringify(result));
    } catch (e) {
        process.stderr.write(e.message);
        process.exit(1);
    }
});`;
        await fs.promises.writeFile(path.join(componentDir, 'index.js'), defaultCode);

        // Install only this new component
        await componentManager.installComponent(id);

        res.json({ success: true, id, message: 'Component created successfully' });
});

// Get a specific component's full details
router.get('/:id', async (req, res) => {
    const componentDir = resolveComponentDir(req.params.id);
    if (!componentDir) return res.status(400).json({ error: INVALID_ID_MESSAGE });
    try {
        await fs.promises.access(componentDir);
    } catch {
        return res.status(404).json({ error: 'Component not found' });
    }

    const componentJson = JSON.parse(await fs.promises.readFile(path.join(componentDir, 'component.json'), 'utf8'));
    const packageJson = JSON.parse(await fs.promises.readFile(path.join(componentDir, 'package.json'), 'utf8'));
    const code = await fs.promises.readFile(path.join(componentDir, 'index.js'), 'utf8');

    // Redact secure input defaults before sending to client
    if (componentJson.inputs) {
        for (const value of Object.values(componentJson.inputs)) {
            if (typeof value === 'object' && value.secure && value.default) {
                value.default = '';  // Clear the actual value
                value._hasStoredValue = true;  // Signal to client that a value exists
            }
        }
    }

    res.json({
        id: req.params.id,
        ...componentJson,
        dependencies: packageJson.dependencies || {},
        code
    });
});

// Update a component
router.put('/:id', validate({ body: UpdateComponentBody }), async (req, res) => {
    const componentDir = resolveComponentDir(req.params.id);
    if (!componentDir) return res.status(400).json({ error: INVALID_ID_MESSAGE });
    // A body that names another component is a save aimed somewhere else — the
    // studio disables the id field while editing, so only a confused client
    // sends one, and it must not overwrite this component with that one's form.
    if (req.body.id !== undefined && req.body.id !== req.params.id) {
        return res.status(400).json({ error: `This body is for component "${req.body.id}", not "${req.params.id}".`, code: 'id_mismatch' });
    }
    if (!fs.existsSync(componentDir)) {
        return res.status(404).json({ error: 'Component not found' });
    }

    const { name, description, category, inputs, outputs, code, dependencies, aiContext, sampleOutput, agentEnabled, directChatEnabled } = req.body;

    // Update component.json
    const componentJsonPath = path.join(componentDir, 'component.json');
    const existingComponent = JSON.parse(await fs.promises.readFile(componentJsonPath, 'utf8'));

    // Preserve secure input defaults if client sends empty placeholder
    let mergedInputs = inputs;
    if (inputs !== undefined && existingComponent.inputs) {
        mergedInputs = { ...inputs };
        for (const [key, value] of Object.entries(mergedInputs)) {
            if (typeof value === 'object' && value.secure && value._hasStoredValue && !value.default) {
                // Client sent placeholder - preserve existing stored value
                const existingInput = existingComponent.inputs[key];
                if (typeof existingInput === 'object' && existingInput.default) {
                    value.default = existingInput.default;
                }
            }
            // Clean up internal flag before saving
            if (typeof value === 'object') {
                delete value._hasStoredValue;
            }
        }
    }

    const updatedComponent = {
        ...existingComponent,
        name: name !== undefined ? name : existingComponent.name,
        description: description !== undefined ? description : existingComponent.description,
        category: category !== undefined ? category : existingComponent.category,
        inputs: mergedInputs !== undefined ? mergedInputs : existingComponent.inputs,
        outputs: outputs !== undefined ? outputs : existingComponent.outputs,
        aiContext: aiContext !== undefined ? aiContext : existingComponent.aiContext,
        sampleOutput: sampleOutput !== undefined ? sampleOutput : existingComponent.sampleOutput,
        agentEnabled: agentEnabled !== undefined ? agentEnabled : existingComponent.agentEnabled,
        directChatEnabled: directChatEnabled !== undefined ? directChatEnabled : existingComponent.directChatEnabled
    };
    await fs.promises.writeFile(componentJsonPath, JSON.stringify(updatedComponent, null, 2));

    // Update package.json if dependencies changed
    if (dependencies !== undefined) {
        const packageJsonPath = path.join(componentDir, 'package.json');
        const existingPackage = JSON.parse(await fs.promises.readFile(packageJsonPath, 'utf8'));
        existingPackage.dependencies = dependencies;
        await fs.promises.writeFile(packageJsonPath, JSON.stringify(existingPackage, null, 2));
    }

    // Update code
    if (code !== undefined) {
        await fs.promises.writeFile(path.join(componentDir, 'index.js'), code);
    }

    // Reinstall only this component if dependencies changed
    if (dependencies !== undefined) {
        await componentManager.installComponent(req.params.id);
    } else {
        // Just reload the definition
        await componentManager.reloadComponent(req.params.id);
    }

    res.json({ success: true, message: 'Component updated successfully' });
});

// Delete a component
router.delete('/:id', async (req, res) => {
    const componentDir = resolveComponentDir(req.params.id);
    if (!componentDir) return res.status(400).json({ error: INVALID_ID_MESSAGE });
    try {
        await fs.promises.access(componentDir);
    } catch {
        return res.status(404).json({ error: 'Component not found' });
    }

    // Remove directory recursively
    await fs.promises.rm(componentDir, { recursive: true, force: true });

    // Remove from memory
    componentManager.removeComponent(req.params.id);

    res.json({ success: true, message: 'Component deleted successfully' });
});

module.exports = router;
