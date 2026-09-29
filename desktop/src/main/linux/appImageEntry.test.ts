import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MARKER, execArgument, planAppImageEntry } from './appImageEntry.ts';

const base = {
    appImage: '/home/tom/Apps/Bee-Flow-1.0.0-linux-x86_64.AppImage',
    appDir: '/tmp/.mount_BeeFloABC',
    execPath: '/tmp/.mount_BeeFloABC/beeflow',
    home: '/home/tom',
    xdgDataHome: undefined,
    systemEntryExists: false,
    existing: null,
};

describe('planAppImageEntry', () => {
    it('writes a marked link handler into the user applications directory', () => {
        const plan = planAppImageEntry(base);
        assert.equal(plan?.action, 'write');
        assert.equal(plan?.file, '/home/tom/.local/share/applications/beeflow.desktop');
        const content = plan?.action === 'write' ? plan.content : '';
        assert.match(content, /^Exec="\/home\/tom\/Apps\/Bee-Flow-1\.0\.0-linux-x86_64\.AppImage" %U$/m);
        assert.match(content, /^MimeType=x-scheme-handler\/beeflow;$/m);
        assert.match(content, /^NoDisplay=true$/m, 'a handler, not a second menu entry');
        assert.match(content, new RegExp(`^${MARKER}$`, 'm'));
    });

    it('does nothing when the file is already right', () => {
        const first = planAppImageEntry(base);
        assert.equal(planAppImageEntry({ ...base, existing: first?.action === 'write' ? first.content : '' }), null);
    });

    it('respects XDG_DATA_HOME', () => {
        assert.equal(planAppImageEntry({ ...base, xdgDataHome: '/data/tom' })?.file, '/data/tom/applications/beeflow.desktop');
    });

    it('is not fooled by an APPIMAGE inherited from another AppImage', () => {
        // A tar.gz copy started from an AppImage terminal sees that terminal's
        // APPIMAGE and APPDIR, but does not run from inside it.
        assert.equal(planAppImageEntry({ ...base, execPath: '/opt/bee-flow/beeflow' }), null);
        assert.equal(planAppImageEntry({ ...base, appDir: undefined }), null);
    });

    it('removes its own entry once a package provides the handler, and only its own', () => {
        const ours = `[Desktop Entry]\nExec="/old/x.AppImage" %U\n${MARKER}\n`;
        assert.deepEqual(planAppImageEntry({ ...base, systemEntryExists: true, existing: ours }), { action: 'remove', file: '/home/tom/.local/share/applications/beeflow.desktop' });
        assert.deepEqual(planAppImageEntry({ ...base, appImage: undefined, appDir: undefined, execPath: '/opt/Bee Flow/beeflow', existing: ours })?.action, 'remove');
        assert.equal(planAppImageEntry({ ...base, systemEntryExists: true, existing: '[Desktop Entry]\nExec=someone-else\n' }), null);
    });

    it("never overwrites a beeflow.desktop someone else wrote", () => {
        assert.equal(planAppImageEntry({ ...base, existing: '[Desktop Entry]\nExec=custom\n' }), null);
    });
});

describe('execArgument', () => {
    it('quotes a path with spaces', () => {
        assert.equal(execArgument('/home/tom/My Apps/Bee Flow.AppImage'), '"/home/tom/My Apps/Bee Flow.AppImage"');
    });

    it('escapes what the Desktop Entry spec says must be escaped, so nothing but the AppImage runs', () => {
        // Inside quotes: " ` $ \ get a backslash; then the value's own escaping
        // doubles every backslash; and % becomes %%.
        assert.equal(execArgument('/x/$(rm -rf ~)`id`"q".AppImage'), '"/x/\\\\$(rm -rf ~)\\\\`id\\\\`\\\\"q\\\\".AppImage"');
        assert.equal(execArgument('/x/100%.AppImage'), '"/x/100%%.AppImage"');
    });
});
