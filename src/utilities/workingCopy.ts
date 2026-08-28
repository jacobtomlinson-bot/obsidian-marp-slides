import { promises as fs } from 'fs';
import { basename, join } from 'path';
import { tmpdir } from 'os';
import { App, TFile } from 'obsidian';
import { FilePath } from './filePath';
import { MarpSlidesSettings } from './settings';
import {
    findRemoteThemeDirective,
    RemoteTheme,
    RemoteThemeCache,
    RemoteThemeCacheOptions,
} from './remoteTheme';

export interface WorkingCopy {
    readonly directory: string;
    readonly path: string;
    readonly sourcePath: string;
    readonly remoteTheme?: RemoteTheme;
}

export interface WorkingCopyProvider {
    create(file: TFile, source?: string, signal?: AbortSignal): Promise<WorkingCopy>;
    read(copy: WorkingCopy): Promise<string>;
    cleanup(copy: WorkingCopy): Promise<void>;
}

export interface WorkingCopyOptions extends RemoteThemeCacheOptions {
    temporaryDirectory?: string;
}

interface OwnedCopy {
    readonly path: string;
    readonly remoteTheme?: RemoteTheme;
}

export class WorkingCopyError extends Error {
    constructor(message: string, cause?: unknown) {
        super(message);
        this.name = 'WorkingCopyError';
        if (cause !== undefined) {
            (this as Error & { cause?: unknown }).cause = cause;
        }
    }
}

/**
 * Owns isolated, off-vault Markdown snapshots used by every Marp renderer.
 * Each refresh gets a new directory, so concurrent writes can never replace a
 * newer snapshot or collide with another note that has the same basename.
 */
export class WorkingCopyManager implements WorkingCopyProvider {
    private readonly app: App;
    private readonly settings: MarpSlidesSettings;
    private readonly temporaryDirectory: string;
    private readonly ownedCopies = new Map<string, OwnedCopy>();
    private readonly remoteThemes: RemoteThemeCache;
    private rootPromise: Promise<string> | undefined;
    private disposed = false;

    constructor(app: App, settings: MarpSlidesSettings, options: WorkingCopyOptions = {}) {
        this.app = app;
        this.settings = settings;
        this.temporaryDirectory = options.temporaryDirectory || tmpdir();
        this.remoteThemes = new RemoteThemeCache(() => this.getRoot(), options);
    }

    async create(file: TFile, source?: string, signal?: AbortSignal): Promise<WorkingCopy> {
        if (this.disposed) {
            throw new WorkingCopyError('Cannot create a Marp working copy after cleanup.');
        }

        let directory: string | undefined;
        let remoteTheme: RemoteTheme | undefined;
        try {
            const root = await this.getRoot();
            directory = await fs.mkdtemp(join(root, 'copy-'));
            const workingPath = join(directory, basename(file.name));
            this.ownedCopies.set(directory, { path: workingPath });

            if (this.disposed) {
                await this.removeOwnedDirectory(directory);
                throw new WorkingCopyError('Cannot create a Marp working copy after cleanup.');
            }

            const sourceText = source === undefined
                ? await this.app.vault.cachedRead(file)
                : source;
            if (signal?.aborted) {
                throw new WorkingCopyError('Temporary Marp working-copy creation was cancelled.');
            }
            let processed = new FilePath(this.settings)
                .convertImageWikiLinks(sourceText, file, this.app);
            const remoteThemeDirective = findRemoteThemeDirective(processed);
            if (remoteThemeDirective !== undefined) {
                remoteTheme = await this.remoteThemes.acquire(remoteThemeDirective.url, signal);
                this.ownedCopies.set(directory, { path: workingPath, remoteTheme });
                processed = remoteThemeDirective.replace(processed, remoteTheme.name);
            }
            if (signal?.aborted) {
                throw new WorkingCopyError('Temporary Marp working-copy creation was cancelled.');
            }
            this.ownedCopies.set(directory, { path: workingPath, remoteTheme });

            await fs.writeFile(workingPath, processed, 'utf8');

            return {
                directory,
                path: workingPath,
                sourcePath: file.path,
                remoteTheme,
            };
        } catch (error) {
            if (directory !== undefined) {
                await this.removeOwnedDirectory(directory);
            }
            if (error instanceof WorkingCopyError) {
                throw error;
            }
            const detail = error instanceof Error ? ` ${error.message}` : '';
            throw new WorkingCopyError(
                `Unable to create a temporary Marp working copy for "${file.path}".${detail}`,
                error,
            );
        }
    }

    async read(copy: WorkingCopy): Promise<string> {
        this.assertOwned(copy);
        try {
            return await fs.readFile(copy.path, 'utf8');
        } catch (error) {
            throw new WorkingCopyError(
                `Unable to read the temporary Marp working copy for "${copy.sourcePath}".`,
                error,
            );
        }
    }

    async cleanup(copy: WorkingCopy): Promise<void> {
        if (this.ownedCopies.get(copy.directory)?.path !== copy.path) {
            return;
        }
        await this.removeOwnedDirectory(copy.directory);
    }

    async dispose(): Promise<void> {
        this.disposed = true;
        await this.remoteThemes.dispose();
        const root = this.rootPromise === undefined ? undefined : await this.rootPromise.catch(() => undefined);
        if (root === undefined) {
            return;
        }

        try {
            await fs.rm(root, { recursive: true, force: true });
            this.ownedCopies.clear();
        } catch (error) {
            // Cleanup is best effort and must not hide a rendering/export error.
            console.error(`Unable to clean temporary Marp directory "${root}".`, error);
        }
    }

    private getRoot(): Promise<string> {
        if (this.rootPromise === undefined) {
            this.rootPromise = fs.mkdtemp(join(this.temporaryDirectory, 'obsidian-marp-slides-'));
        }
        return this.rootPromise;
    }

    private assertOwned(copy: WorkingCopy): void {
        if (this.ownedCopies.get(copy.directory)?.path !== copy.path) {
            throw new WorkingCopyError('Refusing to access a Marp working copy not owned by this plugin session.');
        }
    }

    private async removeOwnedDirectory(directory: string): Promise<void> {
        if (!this.ownedCopies.has(directory)) {
            return;
        }
        const ownedCopy = this.ownedCopies.get(directory);
        try {
            await fs.rm(directory, { recursive: true, force: true });
            this.ownedCopies.delete(directory);
            if (ownedCopy?.remoteTheme !== undefined) {
                await this.remoteThemes.release(ownedCopy.remoteTheme);
            }
        } catch (error) {
            // Keep ownership recorded so dispose() can retry the bounded cleanup.
            console.error(`Unable to clean temporary Marp working copy "${directory}".`, error);
        }
    }
}
