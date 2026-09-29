const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const log = require('../../telemetry/log');

// The shipped components, and every component the designer creates, live in
// <repo>/components — in the container that is /components, which every
// compose file mounts. routes/components.js and routes/ai/agentChat.js write
// there, and componentManager.deps.test.js checks the shipped catalog there.
// This file moved one level down into core/cms/ without its path following,
// and for that time it scanned server/components instead: none of the
// shipped components loaded, and updateComponent wrote into a second copy.
const COMPONENTS_DIR = path.resolve(__dirname, '../../../components');

/**
 * The packages a component may depend on.
 *
 * THIS LIST IS A TRUST BOUNDARY, not a convenience. `npm install` runs
 * lifecycle scripts (preinstall/install/postinstall) by default, as the server
 * process, out of a directory whose package.json a caller supplies — and
 * routes/components.js + routes/ai/agentChat.js both write that file from a
 * request body. So before this list, "create a component" meant "run arbitrary
 * code on the host", before the component itself had executed a single line.
 * The container has no USER directive (server/Dockerfile), so that was root.
 *
 * An allowlist rather than `--ignore-scripts` because two of the shipped
 * components depend on better-sqlite3, a native module that cannot install
 * without its build script. Refusing scripts outright would break them; naming
 * the packages instead keeps every shipped component working and removes the
 * attacker's actual lever, which is choosing the package NAME.
 *
 * Entries are exactly what the components in this repo already declare.
 * Adding one is a deliberate act: it is a code change, reviewed like any
 * other, which is the point — a component author cannot widen it from a
 * request body.
 *
 * What this does NOT defend against: a compromised release of a package that
 * is already on the list. That is the same supply-chain exposure the server's
 * own dependencies carry, and it is not this boundary's job.
 */
const ALLOWED_DEPENDENCIES = new Set([
    'axios',
    'better-sqlite3',
    'cheerio',
    'date-fns',
    'nodemailer',
    'xml2js',
]);

/**
 * Which of a component's declared dependencies are not allowed.
 * Returns [] when the component declares none, which is the common case and
 * skips npm entirely.
 */
function disallowedDependencies(componentPath) {
    let pkg;
    try {
        pkg = JSON.parse(fs.readFileSync(path.join(componentPath, 'package.json'), 'utf8'));
    } catch {
        return []; // no readable package.json → nothing to install, handled below
    }
    const declared = Object.keys(pkg.dependencies || {});
    return declared.filter(name => !ALLOWED_DEPENDENCIES.has(name));
}

/**
 * Install a component's dependencies, or refuse and say why.
 *
 * The three call sites below (boot scan, single install, package.json edit) all
 * went through a bare `exec('npm install --silent')`. They share this now so a
 * future fourth caller cannot reintroduce the hole by copying the old line.
 *
 * Never throws: a component that cannot install is skipped and reported, the
 * same posture the original code had for an npm failure. The component's
 * definition still loads, so an admin sees it in the studio and can read the
 * reason, rather than the component silently vanishing.
 */
async function installDependencies(componentPath, id) {
    const blocked = disallowedDependencies(componentPath);
    if (blocked.length) {
        log.error(
            `[ComponentManager] REFUSED to install dependencies for "${id}": `
            + `${blocked.join(', ')} ${blocked.length === 1 ? 'is' : 'are'} not on the allowlist. `
            + 'npm runs install scripts as this process, so an un-vetted package name is code '
            + 'execution on the host. Add it to ALLOWED_DEPENDENCIES in core/cms/componentManager.js '
            + 'if it is genuinely wanted.',
        );
        return { installed: false, blocked };
    }

    let hasDeps = false;
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(componentPath, 'package.json'), 'utf8'));
        hasDeps = Object.keys(pkg.dependencies || {}).length > 0;
    } catch { /* no package.json → nothing to do */ }
    if (!hasDeps) return { installed: true, blocked: [] };

    await new Promise((resolve) => {
        exec('npm install --silent', { cwd: componentPath }, (error, stdout, stderr) => {
            if (error) log.error(`Failed to install deps for ${id}:`, stderr);
            resolve();
        });
    });
    return { installed: true, blocked: [] };
}

let components = [];

async function initialize() {
    components = []; // Reset on re-initialize
    log.info(`Scanning components in ${COMPONENTS_DIR}...`);
    if (!fs.existsSync(COMPONENTS_DIR)) {
        fs.mkdirSync(COMPONENTS_DIR);
    }

    const entries = fs.readdirSync(COMPONENTS_DIR, { withFileTypes: true });
    const installPromises = [];

    // First pass: load all component definitions
    for (const entry of entries) {
        if (entry.isDirectory()) {
            const componentPath = path.join(COMPONENTS_DIR, entry.name);
            const packageJsonPath = path.join(componentPath, 'package.json');
            const componentJsonPath = path.join(componentPath, 'component.json');

            if (fs.existsSync(packageJsonPath) && fs.existsSync(componentJsonPath)) {
                // Load definition
                try {
                    const definition = JSON.parse(fs.readFileSync(componentJsonPath, 'utf8'));
                    components.push({
                        id: entry.name,
                        path: componentPath,
                        definition: definition
                    });
                } catch (e) {
                    log.error(`Error loading definition for ${entry.name}:`, e);
                }
            }
        }
    }

    log.info(`Found ${components.length} components, installing dependencies...`);

    // Second pass: install all dependencies in parallel
    for (const component of components) {
        installPromises.push(installDependencies(component.path, component.id));
    }

    // Wait for all installations to complete
    await Promise.all(installPromises);
    log.info(`Initialized ${components.length} components.`);
}

function getComponents() {
    return components;
}

function getComponentPath(id) {
    const comp = components.find(c => c.id === id);
    return comp ? comp.path : null;
}

function removeComponent(id) {
    components = components.filter(c => c.id !== id);
}

// Install and add a single new component (for creation)
async function installComponent(id) {
    const componentPath = path.join(COMPONENTS_DIR, id);
    const componentJsonPath = path.join(componentPath, 'component.json');
    const packageJsonPath = path.join(componentPath, 'package.json');

    if (!fs.existsSync(componentJsonPath) || !fs.existsSync(packageJsonPath)) {
        throw new Error(`Component ${id} missing required files`);
    }

    // Load definition
    const definition = JSON.parse(await fs.promises.readFile(componentJsonPath, 'utf8'));

    // Install dependencies — allowlisted only; see installDependencies.
    log.info(`Installing dependencies for ${id}...`);
    await installDependencies(componentPath, id);

    // Remove existing entry if any
    components = components.filter(c => c.id !== id);

    // Add to components list
    components.push({
        id: id,
        path: componentPath,
        definition: definition
    });

    log.info(`Component ${id} installed successfully.`);
}

// Reload a single component's definition (no reinstall of deps)
async function reloadComponent(id) {
    const componentPath = path.join(COMPONENTS_DIR, id);
    const componentJsonPath = path.join(componentPath, 'component.json');

    try {
        await fs.promises.access(componentJsonPath);
    } catch {
        throw new Error(`Component ${id} not found`);
    }

    const definition = JSON.parse(await fs.promises.readFile(componentJsonPath, 'utf8'));

    // Find and update existing component
    const index = components.findIndex(c => c.id === id);
    if (index >= 0) {
        components[index].definition = definition;
    } else {
        components.push({
            id: id,
            path: componentPath,
            definition: definition
        });
    }
}

// Reload all component definitions without reinstalling deps
function reloadAll() {
    const entries = fs.readdirSync(COMPONENTS_DIR, { withFileTypes: true });
    components = [];

    for (const entry of entries) {
        if (entry.isDirectory()) {
            const componentPath = path.join(COMPONENTS_DIR, entry.name);
            const packageJsonPath = path.join(componentPath, 'package.json');
            const componentJsonPath = path.join(componentPath, 'component.json');

            if (fs.existsSync(packageJsonPath) && fs.existsSync(componentJsonPath)) {
                try {
                    const definition = JSON.parse(fs.readFileSync(componentJsonPath, 'utf8'));
                    components.push({
                        id: entry.name,
                        path: componentPath,
                        definition: definition
                    });
                } catch (e) {
                    log.error(`Error loading definition for ${entry.name}:`, e);
                }
            }
        }
    }
    log.info(`Reloaded ${components.length} component definitions.`);
}

// Update a component's files (for AI modification)
async function updateComponent(id, files) {
    const componentPath = path.join(COMPONENTS_DIR, id);

    if (!fs.existsSync(componentPath)) {
        throw new Error(`Component ${id} not found`);
    }

    log.info(`[ComponentManager] Updating component ${id} with ${Object.keys(files).length} files`);

    for (const [filename, content] of Object.entries(files)) {
        const filePath = path.join(componentPath, filename);

        // Security check: prevent directory traversal
        if (!filePath.startsWith(componentPath)) {
            log.warn(`[ComponentManager] Security warning: Attempt to write outside component dir: ${filePath}`);
            continue;
        }

        // If it's a JSON file, ensure it's valid JSON
        if (filename.endsWith('.json') && typeof content === 'string') {
            try {
                // Formatting
                const json = JSON.parse(content);
                await fs.promises.writeFile(filePath, JSON.stringify(json, null, 2), 'utf8');
            } catch (e) {
                log.warn(`[ComponentManager] Invalid JSON for ${filename}, writing as string`, e);
                await fs.promises.writeFile(filePath, content, 'utf8');
            }
        } else {
            await fs.promises.writeFile(filePath, content, 'utf8');
        }
    }

    // If package.json changed, reinstall deps
    if (files['package.json']) {
        // The sharpest of the three: a caller can rewrite package.json through
        // this path as often as it likes, so an un-vetted name here used to be a
        // repeatable way to run install scripts on the host.
        log.info(`[ComponentManager] package.json modified, reinstalling dependencies for ${id}...`);
        await installDependencies(componentPath, id);
    }

    // Reload definition in memory
    await reloadComponent(id);

    return { success: true, message: `Component ${id} updated` };
}

// Read all files for a component (for AI analysis)
async function readComponentFiles(id) {
    const componentPath = path.join(COMPONENTS_DIR, id);
    try {
        await fs.promises.access(componentPath);
    } catch {
        throw new Error(`Component ${id} not found`);
    }

    const files = {};

    async function readDir(dir, relativeRoot = '') {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const relPath = path.join(relativeRoot, entry.name);

            if (entry.isDirectory()) {
                if (entry.name === 'node_modules' || entry.name === '.git') continue;
                await readDir(path.join(dir, entry.name), relPath);
            } else {
                // Only text files we care about
                if (/\.(js|json|css|html|md|txt)$/.test(entry.name)) {
                    files[relPath] = await fs.promises.readFile(path.join(dir, entry.name), 'utf8');
                }
            }
        }
    }

    await readDir(componentPath);
    return files;
}

module.exports = {
    COMPONENTS_DIR,
    ALLOWED_DEPENDENCIES,
    disallowedDependencies,
    installDependencies,
    initialize,
    getComponents,
    getComponentPath,
    removeComponent,
    installComponent,
    reloadComponent,
    reloadAll,
    updateComponent,
    readComponentFiles
};
