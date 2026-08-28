import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { App, TFile, Vault } from 'obsidian';
import { Marp } from '@marp-team/marp-core';
import marpCli from '@marp-team/marp-cli';
import postcss from 'postcss';
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

function hasActiveLocalFileRule(css: string): boolean {
    let active = false;
    postcss.parse(css).walkRules(rule => {
        if (!rule.selector.includes('.evil')) {
            return;
        }
        rule.walkDecls(declaration => {
            active ||= declaration.value.includes('file:///');
        });
    });
    return active;
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

test('rejects anchored remote-theme YAML without rewriting or downloading', async () => {
    const content = [
        '---',
        'theme: &remote https://example.com/a.css',
        'copy: *remote',
        '---',
        '# Deck',
    ].join('\n');
    const fixture = makeFixture('decks/anchored.md', content);
    await fs.mkdir(join(fixture.absoluteSource, '..'), { recursive: true });
    const originalBytes = Buffer.from(content, 'utf8');
    await fs.writeFile(fixture.absoluteSource, originalBytes);
    const writeSpy = jest.spyOn(fs, 'writeFile');
    const fetcher: RemoteThemeFetcher = jest.fn();
    const manager = new WorkingCopyManager(fixture.app, DEFAULT_SETTINGS, {
        temporaryDirectory: testRoot,
        fetcher,
    });

    await expect(manager.create(fixture.file)).rejects.toThrow(
        'without YAML decorations',
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(writeSpy.mock.calls.every(call => call[0] !== fixture.absoluteSource)).toBe(true);
    expect(await fs.readFile(fixture.absoluteSource)).toEqual(originalBytes);

    await manager.dispose();
    writeSpy.mockRestore();
});

test.each([
    '@IMPORT "file:///tmp/local.css";',
    'section { background: u\\72l(file:///etc/passwd) }',
    'section{background-image:image-set("file:///tmp/local-secret.png" 1x)}',
])('rejects decoded unsafe remote CSS before real Core or CLI can receive it: %s', async css => {
    // Both bundled renderers preserve these references, so acquisition must reject them.
    const rawTheme = `/* @theme unsafe-real */\n${css}`;
    const marp = new Marp();
    marp.themeSet.add(rawTheme);
    expect(marp.render('---\ntheme: unsafe-real\n---\n# Raw').css).toContain('file:///');
    const rawThemePath = join(testRoot, 'raw-unsafe.css');
    const rawDeckPath = join(testRoot, 'raw-unsafe.md');
    const rawHtmlPath = join(testRoot, 'raw-unsafe.html');
    await fs.writeFile(rawThemePath, rawTheme, 'utf8');
    await fs.writeFile(rawDeckPath, '---\ntheme: unsafe-real\n---\n# Raw', 'utf8');
    expect(await marpCli([
        rawDeckPath,
        '--theme-set',
        rawThemePath,
        '--allow-local-files',
        '--html',
        '-o',
        rawHtmlPath,
    ])).toBe(0);
    expect(await fs.readFile(rawHtmlPath, 'utf8')).toContain('file:///');

    const content = '---\ntheme: https://themes.example.com/unsafe.css\n---\n# Deck';
    const fixture = makeFixture('decks/unsafe.md', content);
    await fs.mkdir(join(fixture.absoluteSource, '..'), { recursive: true });
    const originalBytes = Buffer.from(content, 'utf8');
    await fs.writeFile(fixture.absoluteSource, originalBytes);
    const writeSpy = jest.spyOn(fs, 'writeFile');
    const manager = new WorkingCopyManager(fixture.app, DEFAULT_SETTINGS, {
        temporaryDirectory: testRoot,
        fetcher: async url => ({
            status: 200,
            headers: { 'content-type': 'text/css' },
            body: Buffer.from(css),
            finalUrl: url,
        }),
    });

    await expect(manager.create(fixture.file)).rejects.toThrow('is not allowed');
    expect(writeSpy.mock.calls.every(call => call[0] !== fixture.absoluteSource)).toBe(true);
    expect(await fs.readFile(fixture.absoluteSource)).toEqual(originalBytes);
    await manager.dispose();
    writeSpy.mockRestore();
});

test('keeps an escaped-quote data image-set inert through working copy, Core, and CLI', async () => {
    const payload = 'section{background-image:image-set("data:x\\");} .evil{background:url(file:///tmp/local-secret.png)} .dummy{content:foo(\\"x")}';
    const content = '---\ntheme: https://themes.example.com/inert.css\n---\n# Inert';
    const fixture = makeFixture('decks/inert.md', content);
    await fs.mkdir(join(fixture.absoluteSource, '..'), { recursive: true });
    const originalBytes = Buffer.from(content, 'utf8');
    await fs.writeFile(fixture.absoluteSource, originalBytes);
    const writeSpy = jest.spyOn(fs, 'writeFile');
    const manager = new WorkingCopyManager(fixture.app, DEFAULT_SETTINGS, {
        temporaryDirectory: testRoot,
        fetcher: async url => ({
            status: 200,
            headers: { 'content-type': 'text/css' },
            body: Buffer.from(payload),
            finalUrl: url,
        }),
    });

    const copy = await manager.create(fixture.file);
    expect(hasActiveLocalFileRule(copy.remoteTheme?.css as string)).toBe(false);
    const marp = new Marp();
    marp.themeSet.add(copy.remoteTheme?.css as string);
    expect(hasActiveLocalFileRule(marp.render(await manager.read(copy)).css)).toBe(false);

    const htmlPath = join(testRoot, 'inert.html');
    expect(await marpCli([
        copy.path,
        '--theme-set',
        copy.remoteTheme?.path as string,
        '--allow-local-files',
        '--html',
        '-o',
        htmlPath,
    ])).toBe(0);
    const html = await fs.readFile(htmlPath, 'utf8');
    const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(match => match[1]);
    expect(styles.length).toBeGreaterThan(0);
    const themeStyles = styles.filter(style => style.includes('local-secret.png'));
    expect(themeStyles.length).toBeGreaterThan(0);
    expect(themeStyles.some(hasActiveLocalFileRule)).toBe(false);
    expect(writeSpy.mock.calls.every(call => call[0] !== fixture.absoluteSource)).toBe(true);
    expect(await fs.readFile(fixture.absoluteSource)).toEqual(originalBytes);

    await manager.cleanup(copy);
    await manager.dispose();
    writeSpy.mockRestore();
});
