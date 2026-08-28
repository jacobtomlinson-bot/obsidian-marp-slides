import { ItemView, WorkspaceLeaf, MarkdownView, normalizePath, Notice, TFile } from 'obsidian';
import { Marp } from '@marp-team/marp-core'
import { browser, type MarpCoreBrowser } from '@marp-team/marp-core/browser'

import { MarpSlidesSettings } from '../utilities/settings'
import { MarpExport } from '../utilities/marpExport';
import { FilePath } from '../utilities/filePath'
import { WorkingCopy, WorkingCopyProvider } from '../utilities/workingCopy';
import { MathOptions } from '@marp-team/marp-core/types/src/math/math';

const markdownItContainer = require('markdown-it-container');
const markdownItMark = require('markdown-it-mark');
const markdownItKroki = require('@kazumatu981/markdown-it-kroki');

export const MARP_PREVIEW_VIEW = 'marp-preview-view';

export class MarpPreviewView extends ItemView  {
    private marp: Marp; 
    
    private marpBrowser: MarpCoreBrowser | undefined;
    private settings : MarpSlidesSettings;

    private file : TFile | undefined;
    private requestedFile: TFile | undefined;
    private workingCopy: WorkingCopy | undefined;
    private renderGeneration = 0;
    private renderAbortController: AbortController | undefined;
    private activeRemoteThemeName: string | undefined;
    private readonly workingCopies: WorkingCopyProvider;
    private readonly exporter: MarpExport;

    constructor(
        settings: MarpSlidesSettings,
        leaf: WorkspaceLeaf,
        workingCopies: WorkingCopyProvider,
        exporter: MarpExport,
    ) {
        super(leaf);

        this.settings = settings;
        this.workingCopies = workingCopies;
        this.exporter = exporter;

        this.marp = new Marp({
            container: { tag: 'div', id: '__marp-vscode' },
            slideContainer: { tag: 'div', 'data-marp-vscode-slide-wrapper': '' },
            html: this.settings.EnableHTML,
            inlineSVG: {
                enabled: true,
                backdropSelector: false
            },
            math: this.settings.MathTypesettings as MathOptions,
            minifyCSS: true,
            script: false
          });

        if (this.settings.EnableMarkdownItPlugins){
          this.marp
            .use(markdownItContainer, "container")
            .use(markdownItMark)
            .use(markdownItKroki,{entrypoint: "https://kroki.io"});
        }
    }

    getViewType() {
        return MARP_PREVIEW_VIEW;
    }

    getDisplayText() {
        return "Deck Preview";
    }

    async onOpen() {
        // console.log("marp slide onopen");

        const container = this.containerEl.children[1];
        container.empty();
        this.marpBrowser = browser(container);

        if (this.settings.ThemePath != '') {        
            const fileContents: string[] = await Promise.all(
                this.app.vault.getFiles()
                    .filter(x => x.parent?.path == normalizePath(this.settings.ThemePath))
                    .map((file) => this.app.vault.cachedRead(file))
            );

            fileContents.forEach((content) => {
                this.marp.themeSet.add(content);
            });
        }

        this.addActions();
    }

    async onClose() {
        this.renderGeneration++;
        this.renderAbortController?.abort();
        this.renderAbortController = undefined;
        this.clearRemoteTheme();
        const workingCopy = this.workingCopy;
        this.workingCopy = undefined;
        this.file = undefined;
        this.requestedFile = undefined;
        if (workingCopy !== undefined) {
            await this.workingCopies.cleanup(workingCopy);
        }
    }

    async onChange(view : MarkdownView) {
        await this.displaySlides(view);
    }

    async onLineChanged(line: number) {
        try {
		    this.containerEl.children[1].children[2].children[line].scrollIntoView();
        } catch {
            console.log("Preview slide not found!")
        }
	}

    async addActions() {
        this.addAction('image', 'Export as PNG', () => {
            this.runExport('png');
        });

        this.addAction('code-glyph', 'Export as HTML', () => {
            this.runExport('html');
        });

        this.addAction('slides-marp-export-pdf', 'Export as PDF', () => {
            this.runExport('pdf');
        });

        this.addAction('slides-marp-export-pptx', 'Export as PPTX', () => {
            this.runExport('pptx');
        });

        this.addAction('slides-marp-slide-present', 'Preview Slides', () => {
            this.runExport('preview');
        });
      }

    async clear(): Promise<void> {
        this.renderGeneration++;
        this.renderAbortController?.abort();
        this.renderAbortController = undefined;
        this.clearRemoteTheme();
        const workingCopy = this.workingCopy;
        this.workingCopy = undefined;
        this.file = undefined;
        this.requestedFile = undefined;
        this.containerEl.children[1].empty();
        if (workingCopy !== undefined) {
            await this.workingCopies.cleanup(workingCopy);
        }
    }

    isDisplaying(file: TFile): boolean {
        return this.file === file || this.file?.path === file.path ||
            this.requestedFile === file || this.requestedFile?.path === file.path;
    }
    
    async displaySlides(view : MarkdownView) {

        if (view.file === null) {
            await this.clear();
            return;
        }

        const generation = ++this.renderGeneration;
        this.renderAbortController?.abort();
        const abortController = new AbortController();
        this.renderAbortController = abortController;
        const switchingNotes =
            (this.file !== undefined && !this.sameFile(this.file, view.file)) ||
            (this.requestedFile !== undefined && !this.sameFile(this.requestedFile, view.file));
        const retiredCopy = switchingNotes ? this.workingCopy : undefined;

        // Disable toolbar exports synchronously when a different note is
        // requested. An async refresh must never leave the old note selectable.
        if (switchingNotes) {
            this.file = undefined;
            this.workingCopy = undefined;
        }
        this.requestedFile = view.file;
        let nextCopy: WorkingCopy | undefined;

        try {
            if (retiredCopy !== undefined) {
                await this.workingCopies.cleanup(retiredCopy);
            }
            if (generation !== this.renderGeneration) {
                return;
            }

            nextCopy = await this.workingCopies.create(view.file, view.data, abortController.signal);
            const processedMarkdown = await this.workingCopies.read(nextCopy);

            if (generation !== this.renderGeneration) {
                await this.workingCopies.cleanup(nextCopy);
                return;
            }

            const filePath = new FilePath(this.settings);
            const basePath = filePath.getCompleteFileBasePath(view.file);
            this.setRemoteTheme(nextCopy);
            let { html, css } = this.marp.render(processedMarkdown);

            // Replace Background Url for images
            html = html.replace(/(?!background-image:url\(&quot;http)background-image:url\(&quot;/g, `background-image:url(&quot;${basePath}`);

            const htmlFile = `
                <!DOCTYPE html>
                <html>
                <head>
                <base href="${basePath}"></base>
                <style id="__marp-vscode-style">${css}</style>
                </head>
                <body>${html}</body>
                </html>
                `;

            const container = this.containerEl.children[1];
            container.empty();
            container.innerHTML = htmlFile;
            this.marpBrowser?.update();

            const previousCopy = this.workingCopy;
            this.workingCopy = nextCopy;
            nextCopy = undefined;
            this.file = view.file;
            if (generation === this.renderGeneration) {
                this.renderAbortController = undefined;
            }

            if (previousCopy !== undefined) {
                await this.workingCopies.cleanup(previousCopy);
            }
        } catch (error) {
            if (nextCopy !== undefined) {
                await this.workingCopies.cleanup(nextCopy);
            }
            if (generation !== this.renderGeneration) {
                return;
            }
            this.renderAbortController = undefined;
            this.clearRemoteTheme();
            const staleCopy = this.workingCopy;
            this.workingCopy = undefined;
            this.file = undefined;
            this.requestedFile = undefined;
            const container = this.containerEl.children[1];
            container.empty();
            container.createEl('p', { text: `Unable to refresh Marp preview: ${this.errorMessage(error)}` });
            if (staleCopy !== undefined) {
                await this.workingCopies.cleanup(staleCopy);
            }
            throw error;
        }
	}

    private runExport(type: string): void {
        if (this.file === undefined) {
            return;
        }
        void this.exporter.export(this.file, type).catch(error => {
            console.error(`Unable to run Marp ${type}.`, error);
            new Notice(`Unable to run Marp ${type}: ${this.errorMessage(error)}`);
        });
    }

    private errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }

    private sameFile(left: TFile, right: TFile): boolean {
        return left === right || left.path === right.path;
    }

    private setRemoteTheme(copy: WorkingCopy): void {
        const nextTheme = copy.remoteTheme;
        if (
            this.activeRemoteThemeName !== undefined &&
            this.activeRemoteThemeName !== nextTheme?.name
        ) {
            this.marp.themeSet.delete(this.activeRemoteThemeName);
        }
        if (nextTheme !== undefined) {
            this.marp.themeSet.add(nextTheme.css);
        }
        this.activeRemoteThemeName = nextTheme?.name;
    }

    private clearRemoteTheme(): void {
        if (this.activeRemoteThemeName !== undefined) {
            this.marp.themeSet.delete(this.activeRemoteThemeName);
            this.activeRemoteThemeName = undefined;
        }
    }
}
