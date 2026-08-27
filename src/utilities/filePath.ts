import { dirname, join, posix, resolve } from 'path';
import { pathToFileURL } from 'url';
import { App, FileSystemAdapter, normalizePath, TFile, Vault } from 'obsidian';
import { MarpSlidesSettings } from './settings';

const IMAGE_EXTENSION = /\.(png|jpg|jpeg|gif|svg|webp|bmp)$/i;
const IMAGE_WIKI_LINK = /!\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g;

function encodePathSegment(segment: string): string {
    if (segment === '.' || segment === '..') {
        return segment;
    }
    return encodeURIComponent(segment).replace(/[!'()*]/g, character =>
        `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
}

function encodeMarkdownPath(path: string): string {
    return path.split('/').map(encodePathSegment).join('/');
}

function escapeAltText(text: string): string {
    return text.replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
}

export function directoryToFileUrl(
    directory: string,
    windows = process.platform === 'win32',
): string {
    const pathWithSeparator = /[/\\]$/.test(directory)
        ? directory
        : `${directory}${windows ? '\\' : '/'}`;
    const platformAwarePathToFileURL = pathToFileURL as unknown as (
        path: string,
        options?: { windows?: boolean },
    ) => URL;
    return platformAwarePathToFileURL(pathWithSeparator, { windows }).href;
}

export class FilePath {
    private readonly settings: MarpSlidesSettings;

    constructor(settings: MarpSlidesSettings) {
        this.settings = settings;
    }

    public isAbsoluteLinkFormat(file: TFile): boolean {
        return (file.vault as Vault & { getConfig(key: string): string })
            .getConfig('newLinkFormat') === 'absolute';
    }

    public getVaultPath(vault: Vault): string {
        return resolve((vault.adapter as FileSystemAdapter).getBasePath());
    }

    public getSourceFilePath(file: TFile): string {
        return resolve(this.getVaultPath(file.vault), ...normalizePath(file.path).split('/'));
    }

    public getCompleteFilePath(file: TFile): string {
        return this.getSourceFilePath(file);
    }

    public getCompleteFileBasePath(file: TFile): string {
        const vaultPath = this.isAbsoluteLinkFormat(file)
            ? normalizePath('/')
            : normalizePath(file.parent?.path || '/');
        const resourcePath = (file.vault.adapter as FileSystemAdapter)
            .getResourcePath(vaultPath)
            .split('?')[0];
        return resourcePath.endsWith('/') ? resourcePath : `${resourcePath}/`;
    }

    /** Base URL passed to Marp CLI so resources still resolve from the source note. */
    public getMarpBaseUrl(file: TFile): string {
        const baseDirectory = this.isAbsoluteLinkFormat(file)
            ? this.getVaultPath(file.vault)
            : dirname(this.getSourceFilePath(file));
        return directoryToFileUrl(baseDirectory);
    }

    public getExportPath(file: TFile, extension: string, useConfiguredPath: boolean): string {
        const directory = useConfiguredPath && this.settings.EXPORT_PATH !== ''
            ? resolve(this.settings.EXPORT_PATH)
            : dirname(this.getSourceFilePath(file));
        return join(directory, `${file.basename}.${extension}`);
    }

    public getThemePath(file: TFile): string {
        return this.settings.ThemePath === ''
            ? ''
            : resolve(this.getVaultPath(file.vault), ...normalizePath(this.settings.ThemePath).split('/'));
    }

    private getPluginDirectory(vault: Vault): string {
        return join(this.getVaultPath(vault), normalizePath(vault.configDir), 'plugins', 'marp-slides');
    }

    public getLibDirectory(vault: Vault): string {
        return join(this.getPluginDirectory(vault), 'lib3');
    }

    public getMarpEngine(vault: Vault): string {
        return join(this.getLibDirectory(vault), 'marp.config.js');
    }

    /** Convert only resolvable Obsidian image embeds in the supplied snapshot. */
    public convertImageWikiLinks(markdown: string, sourceFile: TFile, app: App): string {
        return markdown.replace(IMAGE_WIKI_LINK, (match, rawLink: string, alias?: string) => {
            const linkpath = rawLink.trim();
            if (!IMAGE_EXTENSION.test(linkpath)) {
                return match;
            }

            const linkedFile = app.metadataCache.getFirstLinkpathDest(linkpath, sourceFile.path);
            if (linkedFile === null) {
                return match;
            }

            const targetPath = this.isAbsoluteLinkFormat(sourceFile)
                ? linkedFile.path
                : posix.relative(sourceFile.parent?.path || '', linkedFile.path);
            const alt = alias === undefined || alias === '' ? linkedFile.name : alias;
            return `![${escapeAltText(alt)}](${encodeMarkdownPath(targetPath)})`;
        });
    }
}
