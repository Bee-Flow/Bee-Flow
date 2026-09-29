import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { NextcloudAccount } from '../../shared/types.ts';
import { defaultSaveFolder, folderFor, isInside, remotePathFor, resolveLocalPath, resolveMany, toPosix } from './paths.ts';

const accounts: NextcloudAccount[] = [
    {
        id: '0',
        url: 'https://cloud.example.com',
        user: 'tom',
        davUser: 'tom',
        folders: [
            // Longest first, as clientConfig.ts produces them.
            { localPath: '/home/tom/Nextcloud/Projecten', targetPath: '/Gedeeld/Projecten', accountId: '0', virtualFiles: false },
            { localPath: '/home/tom/Nextcloud', targetPath: '/', accountId: '0', virtualFiles: false },
        ],
    },
    {
        id: '1',
        url: 'https://klant.example.org/nextcloud',
        user: 't.kooy',
        davUser: 'uuid-1234',
        folders: [{ localPath: '/home/tom/Klant', targetPath: '/', accountId: '1', virtualFiles: true }],
    },
];

describe('isInside', () => {
    it('resolves . and .. before deciding', () => {
        assert.equal(isInside('/home/tom/Nextcloud', '/home/tom/Nextcloud/../.config/autostart', 'linux'), false);
        assert.equal(isInside('/home/tom/Nextcloud', '/home/tom/Nextcloud/a/../../x', 'linux'), false);
        assert.equal(isInside('C:\\Users\\tom\\Nextcloud', 'C:\\Users\\tom\\Nextcloud\\..\\AppData\\Roaming', 'win32'), false);
        assert.equal(isInside('/home/tom/Nextcloud', '/home/tom/Nextcloud/a/../b.txt', 'linux'), true, 'a detour that stays inside is fine');
        assert.equal(isInside('/home/tom/Nextcloud', '/home/tom/Nextcloud/./b.txt', 'linux'), true);
        assert.equal(isInside('/home/tom/Nextcloud', '../../etc/passwd', 'linux'), false, 'a relative path that climbs is never inside anything');
    });

    it('respects the path boundary', () => {
        assert.equal(isInside('/home/tom/Nextcloud', '/home/tom/Nextcloud/a.txt', 'linux'), true);
        assert.equal(isInside('/home/tom/Nextcloud', '/home/tom/Nextcloud', 'linux'), true);
        assert.equal(isInside('/home/tom/Nextcloud', '/home/tom/Nextcloud-old/secret.txt', 'linux'), false);
        assert.equal(isInside('/home/tom/Nextcloud', '/home/tom/Nextcloud2', 'linux'), false);
    });

    it('is case-sensitive on Linux and not on macOS or Windows', () => {
        assert.equal(isInside('/home/tom/Nextcloud', '/home/tom/nextcloud/a.txt', 'linux'), false);
        assert.equal(isInside('/Users/tom/Nextcloud', '/Users/tom/nextcloud/a.txt', 'darwin'), true);
        assert.equal(isInside('C:/Users/tom/Nextcloud', 'c:/users/tom/nextcloud/a.txt', 'win32'), true);
    });

    it('treats the two separators as one', () => {
        assert.equal(isInside('C:\\Users\\tom\\Nextcloud', 'C:/Users/tom/Nextcloud/a.txt', 'win32'), true);
    });

    it('handles a filesystem root as a parent', () => {
        assert.equal(isInside('/', '/home/tom/a.txt', 'linux'), true);
    });

    it('says no to empty input rather than yes', () => {
        assert.equal(isInside('', '/home/tom/a.txt', 'linux'), false);
        assert.equal(isInside('/home/tom', '', 'linux'), false);
    });
});

describe('folderFor', () => {
    it('picks the most specific sync folder', () => {
        const match = folderFor('/home/tom/Nextcloud/Projecten/bee/readme.md', accounts, 'linux');
        assert.equal(match?.folder.localPath, '/home/tom/Nextcloud/Projecten');
        assert.equal(match?.account.id, '0');
    });

    it('falls back to the enclosing folder', () => {
        const match = folderFor('/home/tom/Nextcloud/anders.txt', accounts, 'linux');
        assert.equal(match?.folder.localPath, '/home/tom/Nextcloud');
    });

    it('finds the right account when two are synced', () => {
        assert.equal(folderFor('/home/tom/Klant/offerte.pdf', accounts, 'linux')?.account.id, '1');
    });

    it('returns null for a file outside every sync folder', () => {
        assert.equal(folderFor('/home/tom/Downloads/x.pdf', accounts, 'linux'), null);
        assert.equal(folderFor('/tmp/screenshot.png', accounts, 'linux'), null);
    });
});

describe('remotePathFor', () => {
    const projects = accounts[0]!.folders[0]!;
    const root = accounts[0]!.folders[1]!;

    it('maps a file under a folder mounted at the server root', () => {
        assert.equal(remotePathFor(root, '/home/tom/Nextcloud/nota.pdf'), '/nota.pdf');
        assert.equal(remotePathFor(root, '/home/tom/Nextcloud/a/b/c.txt'), '/a/b/c.txt');
    });

    it('prefixes the target path for a folder mounted deeper', () => {
        assert.equal(remotePathFor(projects, '/home/tom/Nextcloud/Projecten/bee/readme.md'), '/Gedeeld/Projecten/bee/readme.md');
    });

    it('maps the folder itself to its mount point', () => {
        assert.equal(remotePathFor(root, '/home/tom/Nextcloud'), '/');
        assert.equal(remotePathFor(projects, '/home/tom/Nextcloud/Projecten'), '/Gedeeld/Projecten');
    });
});

describe('resolveLocalPath', () => {
    it('produces every URL the rest of the app needs', () => {
        const reference = resolveLocalPath('/home/tom/Nextcloud/Projecten/bee/nota.pdf', accounts, { platform: 'linux' });
        assert.equal(reference?.accountId, '0');
        assert.equal(reference?.serverUrl, 'https://cloud.example.com');
        assert.equal(reference?.remotePath, '/Gedeeld/Projecten/bee/nota.pdf');
        assert.equal(reference?.webdavUrl, 'https://cloud.example.com/remote.php/dav/files/tom/Gedeeld/Projecten/bee/nota.pdf');
        assert.match(String(reference?.webUrl), /scrollto=nota\.pdf$/);
        assert.equal(reference?.isDirectory, false);
    });

    it('uses the DAV user of the account the file belongs to', () => {
        const reference = resolveLocalPath('/home/tom/Klant/offerte.pdf', accounts, { platform: 'linux' });
        assert.match(String(reference?.webdavUrl), /\/files\/uuid-1234\/offerte\.pdf$/);
    });

    it('links a directory to its listing rather than to a file in it', () => {
        const reference = resolveLocalPath('/home/tom/Nextcloud/Projecten', accounts, { platform: 'linux', isDirectory: true });
        assert.match(String(reference?.webUrl), /\?dir=%2FGedeeld%2FProjecten$/);
        assert.equal(reference?.isDirectory, true);
    });

    it('returns null for anything outside Nextcloud, rather than guessing', () => {
        assert.equal(resolveLocalPath('/home/tom/Downloads/x.pdf', accounts, { platform: 'linux' }), null);
    });

    it('maps a Windows path', () => {
        const windows: NextcloudAccount[] = [
            {
                id: '0',
                url: 'https://cloud.example.com',
                user: 'tom',
                folders: [{ localPath: 'C:/Users/tom/Nextcloud', targetPath: '/', accountId: '0', virtualFiles: true }],
            },
        ];
        const reference = resolveLocalPath('C:\\Users\\tom\\Nextcloud\\Projecten\\nota.pdf', windows, { platform: 'win32' });
        assert.equal(reference?.remotePath, '/Projecten/nota.pdf');
    });
});

describe('resolveMany', () => {
    it('splits a mixed drop into references and plain uploads', () => {
        const { resolved, unresolved } = resolveMany(
            ['/home/tom/Nextcloud/a.txt', '/home/tom/Downloads/b.pdf', '/home/tom/Klant/c.docx'],
            accounts,
            { platform: 'linux' },
        );
        assert.deepEqual(resolved.map((r) => r.remotePath), ['/a.txt', '/c.docx']);
        assert.deepEqual(unresolved, ['/home/tom/Downloads/b.pdf']);
    });

    it('asks the caller which entries are directories', () => {
        const { resolved } = resolveMany(['/home/tom/Nextcloud/Projecten'], accounts, {
            platform: 'linux',
            isDirectory: (path) => path.endsWith('Projecten'),
        });
        assert.equal(resolved[0]?.isDirectory, true);
    });
});

describe('defaultSaveFolder', () => {
    it('prefers a folder whose files are really on disk', () => {
        assert.equal(defaultSaveFolder(accounts), '/home/tom/Nextcloud/Projecten');
    });

    it('still answers when every folder is a placeholder', () => {
        assert.equal(defaultSaveFolder([accounts[1]!]), '/home/tom/Klant');
    });

    it('returns null when nothing is synced', () => {
        assert.equal(defaultSaveFolder([]), null);
    });
});

describe('toPosix', () => {
    it('collapses separators without mangling a URL-ish path', () => {
        assert.equal(toPosix('C:\\Users\\tom\\\\Nextcloud'), 'C:/Users/tom/Nextcloud');
    });
});
