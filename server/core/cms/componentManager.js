const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const log = require('../../telemetry/log');

// The shipped components live in <repo>/components — in the container that is
// /components, which every compose file mounts. componentManager.deps.test.js
// checks the shipped catalog there. This file moved one level down into
// core/cms/ without its path following, and for that time it scanned
// server/components instead: none of the shipped components loaded.
const COMPONENTS_DIR = path.resolve(__dirname, '../../../components');

/**
 * The packages a component may depend on.
 *
 * THIS LIST IS A TRUST BOUNDARY, not a convenience. `npm install` runs
 * lifecycle scripts (preinstall/install/postinstall) by default, as the server
 * process, out of a component's directory. When components could still be
 * written from a request body (the removed Component Designer), "create a
 * component" meant "run arbitrary code on the host" before this list. Only the
 * shipped, repo-tracked components install now; the list still pins what they
 * may pull in.
 *
 * An allowlist rather than `--ignore-scripts` because two of the shipped
 * components depend on better-sqlite3, a native module that cannot install
 * without its build script. Refusing scripts outright would break them; naming
 * the packages instead keeps every shipped component working and removes the
 * attacker's actual lever, which is choosing the package NAME.
 *
 * Entries are exactly what the components in this repo already declare.
 * Adding one is a deliberate act: it is a code change, reviewed like any
 * other, which is the point.
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
 * The boot scan is the one caller; a future caller goes through this gate
 * rather than a bare `exec('npm install --silent')`.
 *
 * Never throws: a component that cannot install is skipped and reported, the
 * same posture the original code had for an npm failure. The component's
 * definition still loads, so it does not silently vanish.
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

module.exports = {
    COMPONENTS_DIR,
    ALLOWED_DEPENDENCIES,
    disallowedDependencies,
    installDependencies,
    initialize,
    getComponents,
    getComponentPath,
    reloadComponent,
    reloadAll,
};
