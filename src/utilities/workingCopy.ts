import { promises as fs } from 'fs';
import { basename, join } from 'path';
import { tmpdir } from 'os';
import { App, TFile } from 'obsidian';
import { FilePath } from './filePath';
import { MarpSlidesSettings } from './settings';

export interface WorkingCopy {
    readonly directory: string;
    readonly path: string;
    readonly sourcePath: string;
}

export interface WorkingCopyProvider {
    create(file: TFile, source?: string): Promise<WorkingCopy>;
    read(copy: WorkingCopy): Promise<string>;
    cleanup(copy: WorkingCopy): Promise<void>;
}

export interface WorkingCopyOptions {
    temporaryDirectory?: string;
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
    private readonly ownedCopies = new Map<string, string | undefined>();
    private rootPromise: Promise<string> | undefined;
    private disposed = false;

    constructor(app: App, settings: MarpSlidesSettings, options: WorkingCopyOptions = {}) {
        this.app = app;
        this.settings = settings;
        this.temporaryDirectory = options.temporaryDirectory || tmpdir();
    }

    async create(file: TFile, source?: string): Promise<WorkingCopy> {
        if (this.disposed) {
            throw new WorkingCopyError('Cannot create a Marp working copy after cleanup.');
        }

        let directory: string | undefined;
        try {
            const root = await this.getRoot();
            directory = await fs.mkdtemp(join(root, 'copy-'));
            this.ownedCopies.set(directory, undefined);

            if (this.disposed) {
                await this.removeOwnedDirectory(directory);
                throw new WorkingCopyError('Cannot create a Marp working copy after cleanup.');
            }

            const sourceText = source === undefined
                ? await this.app.vault.cachedRead(file)
                : source;
            const processed = new FilePath(this.settings)
                .convertImageWikiLinks(sourceText, file, this.app);
            const workingPath = join(directory, basename(file.name));
            this.ownedCopies.set(directory, workingPath);

            await fs.writeFile(workingPath, processed, 'utf8');

            return {
                directory,
                path: workingPath,
                sourcePath: file.path,
            };
        } catch (error) {
            if (directory !== undefined) {
                await this.removeOwnedDirectory(directory);
            }
            if (error instanceof WorkingCopyError) {
                throw error;
            }
            throw new WorkingCopyError(
                `Unable to create a temporary Marp working copy for "${file.path}".`,
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
        if (this.ownedCopies.get(copy.directory) !== copy.path) {
            return;
        }
        await this.removeOwnedDirectory(copy.directory);
    }

    async dispose(): Promise<void> {
        this.disposed = true;
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
        if (this.ownedCopies.get(copy.directory) !== copy.path) {
            throw new WorkingCopyError('Refusing to access a Marp working copy not owned by this plugin session.');
        }
    }

    private async removeOwnedDirectory(directory: string): Promise<void> {
        if (!this.ownedCopies.has(directory)) {
            return;
        }
        try {
            await fs.rm(directory, { recursive: true, force: true });
            this.ownedCopies.delete(directory);
        } catch (error) {
            // Keep ownership recorded so dispose() can retry the bounded cleanup.
            console.error(`Unable to clean temporary Marp working copy "${directory}".`, error);
        }
    }
}
