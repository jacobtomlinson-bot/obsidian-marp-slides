jest.mock('@marp-team/marp-core', () => ({
    Marp: jest.fn().mockImplementation(() => ({
        render: (markdown: string) => ({ html: `<section>${markdown}</section>`, css: 'slide{}' }),
        themeSet: { add: jest.fn(), delete: jest.fn() },
        use: jest.fn().mockReturnThis(),
    })),
}));

jest.mock('@marp-team/marp-core/browser', () => ({
    browser: jest.fn(() => ({ update: jest.fn() })),
}));

import { Marp } from '@marp-team/marp-core';
import { App, MarkdownView, TFile, Vault, WorkspaceLeaf } from 'obsidian';
import { MarpExport } from '../src/utilities/marpExport';
import { DEFAULT_SETTINGS } from '../src/utilities/settings';
import { WorkingCopy, WorkingCopyProvider } from '../src/utilities/workingCopy';
import { MarpPreviewView } from '../src/views/marpPreviewView';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, reject, resolve };
}

function makeContainer() {
    const content = {
        innerHTML: '',
        empty() { this.innerHTML = ''; },
        createEl(_tag: string, options: { text: string }) { this.innerHTML = options.text; },
    };
    return { content, root: { children: [{}, content] } };
}

function makeFile(path: string): TFile {
    const vault = {
        getConfig: () => 'relative',
        adapter: {
            getBasePath: () => '/vault',
            getResourcePath: (resource: string) => `app://local/${resource}`,
        },
    } as unknown as Vault;
    return {
        vault,
        path,
        name: path.split('/').pop(),
        basename: path.split('/').pop()?.replace(/\.md$/, ''),
        parent: { path: path.split('/').slice(0, -1).join('/') },
    } as unknown as TFile;
}

function makeView(file: TFile, data: string): MarkdownView {
    return { file, data } as unknown as MarkdownView;
}

test('rapid refreshes render only the newest completed generation', async () => {
    const file = makeFile('decks/deck.md');
    const pending = new Map<string, ReturnType<typeof deferred<WorkingCopy>>>();
    const content = new Map<string, string>();
    const cleanup = jest.fn(async () => undefined);
    const provider: WorkingCopyProvider = {
        create: jest.fn(async (_file, source = '') => {
            const copy = deferred<WorkingCopy>();
            pending.set(source, copy);
            const resolved = await copy.promise;
            content.set(resolved.path, source);
            return resolved;
        }),
        read: jest.fn(async copy => content.get(copy.path) as string),
        cleanup,
    };
    const { content: container, root } = makeContainer();
    const leaf = {
        app: { metadataCache: {} } as App,
        containerEl: root,
    } as unknown as WorkspaceLeaf;
    const exporter = { export: jest.fn() } as unknown as MarpExport;
    const preview = new MarpPreviewView(DEFAULT_SETTINGS, leaf, provider, exporter);

    const renderA = preview.displaySlides(makeView(file, 'A'));
    const renderB = preview.displaySlides(makeView(file, 'B'));
    const renderC = preview.displaySlides(makeView(file, 'C'));

    pending.get('C')?.resolve({ directory: '/tmp/c', path: '/tmp/c/deck.md', sourcePath: file.path });
    await renderC;
    expect(container.innerHTML).toContain('<section>C</section>');

    pending.get('A')?.resolve({ directory: '/tmp/a', path: '/tmp/a/deck.md', sourcePath: file.path });
    pending.get('B')?.resolve({ directory: '/tmp/b', path: '/tmp/b/deck.md', sourcePath: file.path });
    await Promise.all([renderA, renderB]);

    expect(container.innerHTML).toContain('<section>C</section>');
    expect(cleanup).toHaveBeenCalledWith(expect.objectContaining({ directory: '/tmp/a' }));
    expect(cleanup).toHaveBeenCalledWith(expect.objectContaining({ directory: '/tmp/b' }));

    await preview.onClose();
    expect(cleanup).toHaveBeenCalledWith(expect.objectContaining({ directory: '/tmp/c' }));
});

test('note switches replace and clean the previous preview working copy', async () => {
    const copies: WorkingCopy[] = [];
    const cleanup = jest.fn(async () => undefined);
    const provider: WorkingCopyProvider = {
        create: jest.fn(async (file, source = '') => {
            const copy = {
                directory: `/tmp/${copies.length}`,
                path: `/tmp/${copies.length}/${file.name}`,
                sourcePath: file.path,
            };
            copies.push(copy);
            return copy;
        }),
        read: jest.fn(async copy => copy.sourcePath),
        cleanup,
    };
    const { content: container, root } = makeContainer();
    const leaf = {
        app: { metadataCache: {} } as App,
        containerEl: root,
    } as unknown as WorkspaceLeaf;
    const preview = new MarpPreviewView(
        DEFAULT_SETTINGS,
        leaf,
        provider,
        { export: jest.fn() } as unknown as MarpExport,
    );
    const first = makeFile('one/deck.md');
    const second = makeFile('two/deck.md');

    await preview.displaySlides(makeView(first, 'first'));
    await preview.displaySlides(makeView(second, 'second'));

    expect(container.innerHTML).toContain('two/deck.md');
    expect(preview.isDisplaying(second)).toBe(true);
    expect(cleanup).toHaveBeenCalledWith(copies[0]);

    await preview.clear();
    expect(container.innerHTML).toBe('');
    expect(cleanup).toHaveBeenCalledWith(copies[1]);
});

test('working-copy failures clear stale preview output and reject to the caller', async () => {
    const provider: WorkingCopyProvider = {
        create: jest.fn(async () => { throw new Error('temporary disk unavailable'); }),
        read: jest.fn(),
        cleanup: jest.fn(async () => undefined),
    };
    const { content: container, root } = makeContainer();
    container.innerHTML = 'stale preview';
    const leaf = {
        app: { metadataCache: {} } as App,
        containerEl: root,
    } as unknown as WorkspaceLeaf;
    const preview = new MarpPreviewView(
        DEFAULT_SETTINGS,
        leaf,
        provider,
        { export: jest.fn() } as unknown as MarpExport,
    );

    await expect(preview.displaySlides(makeView(makeFile('deck.md'), 'new')))
        .rejects.toThrow('temporary disk unavailable');
    expect(container.innerHTML).toContain('Unable to refresh Marp preview');
    expect(container.innerHTML).not.toContain('stale preview');
});

test('a deferred failed note switch cannot export or retain the previous note', async () => {
    const first = makeFile('one/deck.md');
    const second = makeFile('two/deck.md');
    const firstCopy = {
        directory: '/tmp/first',
        path: '/tmp/first/deck.md',
        sourcePath: first.path,
    };
    const pendingSwitch = deferred<WorkingCopy>();
    const cleanup = jest.fn(async () => undefined);
    const provider: WorkingCopyProvider = {
        create: jest.fn(async (file) => {
            if (file === second) {
                return pendingSwitch.promise;
            }
            return firstCopy;
        }),
        read: jest.fn(async copy => copy.sourcePath),
        cleanup,
    };
    const exporter = { export: jest.fn(async () => undefined) } as unknown as MarpExport;
    const { root } = makeContainer();
    const leaf = {
        app: { metadataCache: {} } as App,
        containerEl: root,
    } as unknown as WorkspaceLeaf;
    const preview = new MarpPreviewView(DEFAULT_SETTINGS, leaf, provider, exporter);

    await preview.displaySlides(makeView(first, 'first'));
    const switchResult = preview.displaySlides(makeView(second, 'second'));

    (preview as unknown as { runExport(type: string): void }).runExport('pdf');
    expect(exporter.export).not.toHaveBeenCalled();

    await Promise.resolve();
    expect(cleanup).toHaveBeenCalledWith(firstCopy);
    pendingSwitch.reject(new Error('switch refresh failed'));
    await expect(switchResult).rejects.toThrow('switch refresh failed');

    (preview as unknown as { runExport(type: string): void }).runExport('pdf');
    expect(exporter.export).not.toHaveBeenCalled();
    expect(preview.isDisplaying(first)).toBe(false);
    expect(preview.isDisplaying(second)).toBe(false);
});

test('preview registers the exact cached remote CSS and retires it on a local-theme refresh', async () => {
    const remoteFile = makeFile('remote/deck.md');
    const nextRemoteFile = makeFile('remote/next.md');
    const localFile = makeFile('local/deck.md');
    const remoteTheme = {
        url: 'https://themes.example.com/deck.css',
        finalUrl: 'https://themes.example.com/deck.css',
        name: 'obsidian-marp-remote-1234',
        path: '/tmp/session/themes/remote.css',
        css: 'section { color: purple } /* @theme obsidian-marp-remote-1234 */',
    };
    const nextRemoteTheme = {
        ...remoteTheme,
        url: 'https://themes.example.com/next.css',
        finalUrl: 'https://themes.example.com/next.css',
        name: 'obsidian-marp-remote-5678',
        path: '/tmp/session/themes/next.css',
        css: 'section { color: orange } /* @theme obsidian-marp-remote-5678 */',
    };
    const provider: WorkingCopyProvider = {
        create: jest.fn(async file => ({
            directory: `/tmp/${file.parent?.path}`,
            path: `/tmp/${file.path}`,
            sourcePath: file.path,
            remoteTheme: file === remoteFile
                ? remoteTheme
                : file === nextRemoteFile ? nextRemoteTheme : undefined,
        })),
        read: jest.fn(async copy => copy.remoteTheme === undefined
            ? '---\ntheme: gaia\n---\n# Local'
            : `---\ntheme: ${copy.remoteTheme.name}\n---\n# Remote`),
        cleanup: jest.fn(async () => undefined),
    };
    const { content, root } = makeContainer();
    const leaf = {
        app: { metadataCache: {} } as App,
        containerEl: root,
    } as unknown as WorkspaceLeaf;
    const preview = new MarpPreviewView(
        DEFAULT_SETTINGS,
        leaf,
        provider,
        { export: jest.fn() } as unknown as MarpExport,
    );
    const marpInstance = (Marp as unknown as jest.Mock).mock.results.slice(-1)[0].value;

    await preview.displaySlides(makeView(remoteFile, '# Remote source'));
    expect(marpInstance.themeSet.add).toHaveBeenCalledWith(remoteTheme.css);
    expect(content.innerHTML).toContain(remoteTheme.name);

    await preview.displaySlides(makeView(nextRemoteFile, '# Next remote source'));
    expect(marpInstance.themeSet.delete).toHaveBeenCalledWith(remoteTheme.name);
    expect(marpInstance.themeSet.add).toHaveBeenCalledWith(nextRemoteTheme.css);
    expect(content.innerHTML).toContain(nextRemoteTheme.name);

    await preview.displaySlides(makeView(localFile, '# Local source'));
    expect(marpInstance.themeSet.delete).toHaveBeenCalledWith(nextRemoteTheme.name);
    expect(content.innerHTML).toContain('theme: gaia');
    await preview.onClose();
});

test('a newer preview generation cancels unused remote acquisition without surfacing a stale error', async () => {
    const firstFile = makeFile('remote/first.md');
    const secondFile = makeFile('remote/second.md');
    let firstSignal: AbortSignal | undefined;
    const secondCopy = {
        directory: '/tmp/second',
        path: '/tmp/second/second.md',
        sourcePath: secondFile.path,
    };
    const provider: WorkingCopyProvider = {
        create: jest.fn(async (file, _source, signal) => {
            if (file === secondFile) {
                return secondCopy;
            }
            firstSignal = signal;
            return new Promise<WorkingCopy>((_resolve, reject) => {
                signal?.addEventListener('abort', () => reject(new Error('cancelled remote fetch')));
            });
        }),
        read: jest.fn(async copy => copy.sourcePath),
        cleanup: jest.fn(async () => undefined),
    };
    const { content, root } = makeContainer();
    const preview = new MarpPreviewView(
        DEFAULT_SETTINGS,
        {
            app: { metadataCache: {} } as App,
            containerEl: root,
        } as unknown as WorkspaceLeaf,
        provider,
        { export: jest.fn() } as unknown as MarpExport,
    );

    const firstRender = preview.displaySlides(makeView(firstFile, 'first'));
    const secondRender = preview.displaySlides(makeView(secondFile, 'second'));
    await Promise.all([firstRender, secondRender]);

    expect(firstSignal?.aborted).toBe(true);
    expect(content.innerHTML).toContain(secondFile.path);
    expect(content.innerHTML).not.toContain('Unable to refresh');
    await preview.onClose();
});
