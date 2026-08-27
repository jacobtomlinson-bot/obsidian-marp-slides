import marpCli, { CLIError, CLIErrorCode } from '@marp-team/marp-cli';
import { TFile } from 'obsidian';
import { MarpSlidesSettings } from './settings';
import { FilePath } from './filePath';
import { WorkingCopyProvider } from './workingCopy';

export class MarpCLIError extends Error {}

export type MarpCliRunner = (
    argv: string[],
    options?: { baseUrl?: string },
) => Promise<number>;

let marpRunQueue: Promise<void> = Promise.resolve();

export class MarpExport {
    private readonly settings: MarpSlidesSettings;
    private readonly workingCopies: WorkingCopyProvider;
    private readonly cli: MarpCliRunner;

    constructor(
        settings: MarpSlidesSettings,
        workingCopies: WorkingCopyProvider,
        cli: MarpCliRunner = marpCli,
    ) {
        this.settings = settings;
        this.workingCopies = workingCopies;
        this.cli = cli;
    }

    async export(file: TFile, type: string): Promise<void> {
        const filesTool = new FilePath(this.settings);
        const workingCopy = await this.workingCopies.create(file);

        try {
            const argv = this.buildArguments(file, workingCopy.path, type, filesTool);
            const resourcesPath = filesTool.getLibDirectory(file.vault);
            const baseUrl = filesTool.getMarpBaseUrl(file);
            await this.run(argv, resourcesPath, baseUrl);
        } finally {
            await this.workingCopies.cleanup(workingCopy);
        }
    }

    private buildArguments(
        file: TFile,
        workingPath: string,
        type: string,
        filesTool: FilePath,
    ): string[] {
        const argv: string[] = [workingPath, '--allow-local-files'];
        const themePath = filesTool.getThemePath(file);

        if (this.settings.EnableMarkdownItPlugins) {
            argv.push('--engine', filesTool.getMarpEngine(file.vault));
        }

        if (themePath !== '') {
            argv.push('--theme-set', themePath);
        }

        switch (type) {
            case 'pdf':
                argv.push('--pdf', '-o', filesTool.getExportPath(file, 'pdf', true));
                break;
            case 'pdf-with-notes':
                argv.push(
                    '--pdf',
                    '--pdf-notes',
                    '--pdf-outlines',
                    '-o',
                    filesTool.getExportPath(file, 'pdf', true),
                );
                break;
            case 'pptx':
                argv.push('--pptx', '-o', filesTool.getExportPath(file, 'pptx', true));
                break;
            case 'png':
                argv.push('--images', '--png', '-o', filesTool.getExportPath(file, 'png', true));
                break;
            case 'html':
                argv.push(
                    '--html',
                    '--template',
                    this.settings.HTMLExportMode,
                    '-o',
                    filesTool.getExportPath(file, 'html', false),
                );
                break;
            case 'preview':
                argv.push('--html', '--preview');
                break;
            default:
                throw new MarpCLIError(`Unsupported Marp export type: ${type}`);
        }

        return argv;
    }

    private async run(argv: string[], resourcesPath: string, baseUrl: string): Promise<void> {
        try {
            const queuedRun = marpRunQueue.then(async () => {
                const { CHROME_PATH } = process.env;
                try {
                    const configuredChromePath = this.settings.CHROME_PATH || CHROME_PATH;
                    if (configuredChromePath === undefined) {
                        delete process.env.CHROME_PATH;
                    } else {
                        process.env.CHROME_PATH = configuredChromePath;
                    }
                    await this.runMarpCli(argv, resourcesPath, baseUrl);
                } finally {
                    if (CHROME_PATH === undefined) {
                        delete process.env.CHROME_PATH;
                    } else {
                        process.env.CHROME_PATH = CHROME_PATH;
                    }
                }
            });
            marpRunQueue = queuedRun.catch(() => undefined);
            await queuedRun;
        } catch (error) {
            if (
                error instanceof CLIError &&
                error.errorCode === CLIErrorCode.NOT_FOUND_CHROMIUM
            ) {
                const browsers = ['[Google Chrome](https://www.google.com/chrome/)'];

                if (process.platform === 'linux') {
                    browsers.push('[Chromium](https://www.chromium.org/)');
                }

                browsers.push('[Microsoft Edge](https://www.microsoft.com/edge)');

                throw new MarpCLIError(
                    `It requires to install ${browsers
                        .join(', ')
                        .replace(/, ([^,]*)$/, ' or $1')} for exporting.`,
                );
            }

            throw error;
        }
    }

    private async runMarpCli(argv: string[], resourcesPath: string, baseUrl: string): Promise<void> {
        console.info(`Execute Marp CLI [${argv.join(' ')}]`);
        const originalDirname = __dirname;

        try {
            __dirname = resourcesPath;
            const exitCode = await this.cli(argv, { baseUrl });
            if (exitCode !== 0) {
                throw new MarpCLIError(`Marp export failed with exit status ${exitCode}.`);
            }
        } finally {
            __dirname = originalDirname;
        }
    }
}
