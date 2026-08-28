import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { App, TFile, Vault } from 'obsidian';
import { Marp } from '@marp-team/marp-core';
import marpCli from '@marp-team/marp-cli';
import { DEFAULT_SETTINGS } from '../src/utilities/settings';
import { WorkingCopyManager } from '../src/utilities/workingCopy';
import { RemoteThemeFetcher } from '../src/utilities/remoteTheme';

let testRoot: string;

beforeEach(async () => {
    testRoot = await fs.mkdtemp(join(tmpdir(), 'marp-working-copy-test-'));
});

afterEach(async () => {
    await fs.rm(testRoot, { recursive: true, force: true });
});

function makeFixture(sourcePath = 'decks/deck.md', content = '# Deck\n\n![[image.png]]') {
    const vaultRoot = join(testRoot, 'vault');
    const absoluteSource = join(vaultRoot, ...sourcePath.split('/'));
    const vault = {
        configDir: '.obsidian',
        getConfig: () => 'relative',
        adapter: { getBasePath: () => vaultRoot },
        cachedRead: async () => fs.readFile(absoluteSource, 'utf8'),
    } as unknown as Vault;
    const file = {
        vault,
        path: sourcePath,
        name: sourcePath.split('/').pop(),
        basename: sourcePath.split('/').pop()?.replace(/\.md$/, ''),
        parent: { path: sourcePath.split('/').slice(0, -1).join('/') },
    } as unknown as TFile;
    const image = {
        vault,
        path: 'assets/image.png',
        name: 'image.png',
        parent: { path: 'assets' },
    } as unknown as TFile;
    const app = {
        vault,
        metadataCache: {
            getFirstLinkpathDest: (linkpath: string) => linkpath === 'image.png' ? image : null,
        },
    } as unknown as App;

    return { absoluteSource, app, content, file };
}

test('creates a converted off-vault snapshot and leaves source bytes unchanged', async () => {
    const fixture = makeFixture();
    await fs.mkdir(join(fixture.absoluteSource, '..'), { recursive: true });
    const originalBytes = Buffer.from(`${fixture.content}\r\nBinary-like: \u0000 end`, 'utf8');
    await fs.writeFile(fixture.absoluteSource, originalBytes);
    const writeSpy = jest.spyOn(fs, 'writeFile');
    const manager = new WorkingCopyManager(fixture.app, DEFAULT_SETTINGS, {
        temporaryDirectory: testRoot,
    });

    const copy = await manager.create(fixture.file);

    expect(copy.path).not.toBe(fixture.absoluteSource);
    expect(writeSpy.mock.calls.every(call => call[0] !== fixture.absoluteSource)).toBe(true);
    expect(copy.directory.startsWith(testRoot)).toBe(true);
    const workingMarkdown = await manager.read(copy);
    expect(workingMarkdown).toContain('![image.png](../assets/image.png)');
    expect(new Marp().render(workingMarkdown).html)
        .toContain('<img src="../assets/image.png" alt="image.png" />');
    expect(await fs.readFile(fixture.absoluteSource)).toEqual(originalBytes);

    await manager.cleanup(copy);
    await expect(fs.stat(copy.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(fixture.absoluteSource)).toEqual(originalBytes);
    await manager.dispose();
    writeSpy.mockRestore();
});

test('isolates notes with the same basename and overlapping snapshots', async () => {
    const first = makeFixture('one/deck.md');
    const second = makeFixture('two/deck.md');
    const manager = new WorkingCopyManager(first.app, DEFAULT_SETTINGS, {
        temporaryDirectory: testRoot,
    });

    const [copyA, copyB, copyC] = await Promise.all([
        manager.create(first.file, 'A'),
        manager.create(second.file, 'B'),
        manager.create(first.file, 'C'),
    ]);

    expect(new Set([copyA.directory, copyB.directory, copyC.directory]).size).toBe(3);
    expect(await manager.read(copyA)).toBe('A');
    expect(await manager.read(copyB)).toBe('B');
    expect(await manager.read(copyC)).toBe('C');

    await manager.cleanup({ ...copyA, path: copyB.path });
    expect(await manager.read(copyA)).toBe('A');

    await Promise.all([manager.cleanup(copyA), manager.cleanup(copyB), manager.cleanup(copyC)]);
    await manager.dispose();
});

test('uses the supplied editor snapshot instead of stale vault content', async () => {
    const fixture = makeFixture();
    const manager = new WorkingCopyManager(fixture.app, DEFAULT_SETTINGS, {
        temporaryDirectory: testRoot,
    });

    const copy = await manager.create(fixture.file, '# newest editor snapshot');

    expect(await manager.read(copy)).toBe('# newest editor snapshot');
    await manager.dispose();
    await expect(fs.stat(copy.directory)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('fails closed when the source cannot be read and leaves no usable copy', async () => {
    const fixture = makeFixture();
    const manager = new WorkingCopyManager(fixture.app, DEFAULT_SETTINGS, {
        temporaryDirectory: testRoot,
    });

    await expect(manager.create(fixture.file)).rejects.toThrow(
        'Unable to create a temporary Marp working copy',
    );
    await manager.dispose();
});

test('downloads a URL theme off-vault and rewrites only the temporary snapshot', async () => {
    const content = [
        '---',
        'marp: true',
        'theme: https://themes.example.com/remote.css',
        '---',
        '# Deck',
        '![[image.png]]',
    ].join('\r\n');
    const fixture = makeFixture('decks/remote.md', content);
    await fs.mkdir(join(fixture.absoluteSource, '..'), { recursive: true });
    const originalBytes = Buffer.from(content, 'utf8');
    await fs.writeFile(fixture.absoluteSource, originalBytes);
    const writeSpy = jest.spyOn(fs, 'writeFile');
    const fetcher: RemoteThemeFetcher = jest.fn(async url => ({
        status: 200,
        headers: { 'content-type': 'text/css', etag: '"remote-v1"' },
        body: Buffer.from([
            'section {',
            '  color: rebeccapurple;',
            '  background-image: url("//assets.example.com/background.png");',
            '}',
        ].join('\n')),
        finalUrl: url,
    }));
    const manager = new WorkingCopyManager(fixture.app, DEFAULT_SETTINGS, {
        temporaryDirectory: testRoot,
        fetcher,
    });

    const copy = await manager.create(fixture.file);

    expect(copy.remoteTheme?.path.startsWith(testRoot)).toBe(true);
    expect(copy.remoteTheme?.path).not.toContain(fixture.absoluteSource);
    expect(await manager.read(copy)).toContain(`theme: ${copy.remoteTheme?.name}`);
    expect(await manager.read(copy)).toContain('![image.png](../assets/image.png)');
    expect(await fs.readFile(copy.remoteTheme?.path as string, 'utf8'))
        .toBe(copy.remoteTheme?.css);
    expect(copy.remoteTheme?.css).toContain('https://assets.example.com/background.png');
    const marp = new Marp();
    marp.themeSet.add(copy.remoteTheme?.css as string);
    expect(marp.render(await manager.read(copy)).css).toContain('rebeccapurple');
    expect(marp.render(await manager.read(copy)).css)
        .toContain('https://assets.example.com/background.png');
    const htmlPath = join(testRoot, 'remote-theme.html');
    expect(await marpCli([
        copy.path,
        '--theme-set',
        copy.remoteTheme?.path as string,
        '--html',
        '-o',
        htmlPath,
    ])).toBe(0);
    expect(await fs.readFile(htmlPath, 'utf8'))
        .toContain('https://assets.example.com/background.png');
    expect(writeSpy.mock.calls.every(call => call[0] !== fixture.absoluteSource)).toBe(true);
    expect(await fs.readFile(fixture.absoluteSource)).toEqual(originalBytes);

    await manager.cleanup(copy);
    expect(await fs.readFile(fixture.absoluteSource)).toEqual(originalBytes);
    await manager.dispose();
    writeSpy.mockRestore();
});

test('remote theme acquisition failures preserve source bytes and leave no working copy', async () => {
    const content = '---\ntheme: https://themes.example.com/fail.css\n---\n# Deck';
    const fixture = makeFixture('decks/fail.md', content);
    await fs.mkdir(join(fixture.absoluteSource, '..'), { recursive: true });
    const originalBytes = Buffer.from(content, 'utf8');
    await fs.writeFile(fixture.absoluteSource, originalBytes);
    const manager = new WorkingCopyManager(fixture.app, DEFAULT_SETTINGS, {
        temporaryDirectory: testRoot,
        fetcher: async () => { throw new Error('network unavailable'); },
    });

    await expect(manager.create(fixture.file)).rejects.toThrow('Unable to create a temporary Marp working copy');
    expect(await fs.readFile(fixture.absoluteSource)).toEqual(originalBytes);
    await manager.dispose();
});
