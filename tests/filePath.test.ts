import { join, sep } from 'path';
import { pathToFileURL } from 'url';
import { App, TFile, Vault } from 'obsidian';
import { directoryToFileUrl, FilePath } from '../src/utilities/filePath';
import { DEFAULT_SETTINGS } from '../src/utilities/settings';

function makeVault(basePath: string, linkFormat: 'relative' | 'absolute'): Vault {
    return {
        configDir: '.obsidian',
        getConfig: () => linkFormat,
        adapter: {
            getBasePath: () => basePath,
            getResourcePath: (path: string) => `app://local/${path}?cache=1`,
        },
    } as unknown as Vault;
}

function makeFile(vault: Vault, path: string): TFile {
    const name = path.split('/').pop() as string;
    return {
        vault,
        path,
        name,
        basename: name.replace(/\.md$/, ''),
        parent: { path: path.split('/').slice(0, -1).join('/') },
    } as unknown as TFile;
}

function makeApp(destinations: Record<string, TFile | undefined>): App {
    return {
        metadataCache: {
            getFirstLinkpathDest: (linkpath: string) => destinations[linkpath] || null,
        },
    } as unknown as App;
}

test('builds source, resource and Marp base paths without relocating the source note', () => {
    const vault = makeVault('/vault with spaces', 'relative');
    const file = makeFile(vault, 'decks/nested/deck.md');
    const paths = new FilePath(DEFAULT_SETTINGS);

    expect(paths.getCompleteFilePath(file)).toBe(join('/vault with spaces', 'decks', 'nested', 'deck.md'));
    expect(paths.getCompleteFileBasePath(file)).toBe('app://local/decks/nested/');
    expect(paths.getMarpBaseUrl(file)).toBe(pathToFileURL(`${join('/vault with spaces', 'decks', 'nested')}${sep}`).href);
});

test('uses the vault root as the base for Obsidian absolute links', () => {
    const vault = makeVault('/vault', 'absolute');
    const file = makeFile(vault, 'decks/deck.md');
    const paths = new FilePath(DEFAULT_SETTINGS);

    expect(paths.getCompleteFilePath(file)).toBe(join('/vault', 'decks', 'deck.md'));
    expect(paths.getCompleteFileBasePath(file)).toBe('app://local//');
    expect(paths.getMarpBaseUrl(file)).toBe(pathToFileURL(`/vault${sep}`).href);
});

test('converts resolved relative wiki images and preserves standard and non-image links', () => {
    const vault = makeVault('/vault', 'relative');
    const source = makeFile(vault, 'decks/talk/deck.md');
    const image = makeFile(vault, 'assets/diagram.png');
    const app = makeApp({ 'diagram.png': image });
    const markdown = [
        '![[diagram.png]]',
        '![[diagram.png|Architecture]]',
        '![[notes.md]]',
        '![standard](../../assets/diagram.png)',
    ].join('\n');

    expect(new FilePath(DEFAULT_SETTINGS).convertImageWikiLinks(markdown, source, app)).toBe([
        '![diagram.png](../../assets/diagram.png)',
        '![Architecture](../../assets/diagram.png)',
        '![[notes.md]]',
        '![standard](../../assets/diagram.png)',
    ].join('\n'));
});

test('converts absolute-mode wiki images to vault-root paths', () => {
    const vault = makeVault('/vault', 'absolute');
    const source = makeFile(vault, 'decks/deck.md');
    const image = makeFile(vault, 'assets/diagram.svg');
    const app = makeApp({ 'assets/diagram.svg': image });

    expect(new FilePath(DEFAULT_SETTINGS).convertImageWikiLinks(
        '![[assets/diagram.svg]]',
        source,
        app,
    )).toBe('![diagram.svg](assets/diagram.svg)');
});

test('URL-encodes special and Unicode image paths and preserves aliases', () => {
    const vault = makeVault('/vault', 'relative');
    const source = makeFile(vault, 'deck.md');
    const image = makeFile(vault, 'media/über view (final)#1.png');
    const app = makeApp({ 'über view (final)#1.png': image });

    expect(new FilePath(DEFAULT_SETTINGS).convertImageWikiLinks(
        '![[über view (final)#1.png|A (special) view]]',
        source,
        app,
    )).toBe('![A (special) view](media/%C3%BCber%20view%20%28final%29%231.png)');
});

test('leaves unresolved images and unsupported embeds unchanged', () => {
    const vault = makeVault('/vault', 'relative');
    const source = makeFile(vault, 'deck.md');
    const app = makeApp({});
    const markdown = '![[missing.png]]\n![[document.pdf]]\n![[note.md]]';

    expect(new FilePath(DEFAULT_SETTINGS).convertImageWikiLinks(markdown, source, app)).toBe(markdown);
});

test('constructs file URLs for POSIX, Windows drive and UNC directories', () => {
    expect(directoryToFileUrl('/Users/Jacob/Vault Folder', false))
        .toBe('file:///Users/Jacob/Vault%20Folder/');
    expect(directoryToFileUrl('C:\\Users\\Jacob\\Vault Folder', true))
        .toBe('file:///C:/Users/Jacob/Vault%20Folder/');
    expect(directoryToFileUrl('\\\\server\\share\\Vault Folder', true))
        .toBe('file://server/share/Vault%20Folder/');
});
