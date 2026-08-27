import { promises as fs } from 'fs';
import { dirname, join, resolve, sep } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import { App, TFile, Vault } from 'obsidian';
import { MarpCliRunner, MarpExport } from '../src/utilities/marpExport';
import { DEFAULT_SETTINGS, MarpSlidesSettings } from '../src/utilities/settings';
import { WorkingCopyManager } from '../src/utilities/workingCopy';

let testRoot: string;

beforeEach(async () => {
    testRoot = await fs.mkdtemp(join(tmpdir(), 'marp-export-test-'));
});

afterEach(async () => {
    await fs.rm(testRoot, { recursive: true, force: true });
});

async function makeFixture(linkFormat: 'relative' | 'absolute' = 'relative') {
    const vaultRoot = join(testRoot, 'vault');
    const sourcePath = 'decks/my deck.md';
    const absoluteSource = join(vaultRoot, ...sourcePath.split('/'));
    const originalBytes = Buffer.from('# Deck\r\n\r\n![[image.png]]\r\n', 'utf8');
    await fs.mkdir(dirname(absoluteSource), { recursive: true });
    await fs.writeFile(absoluteSource, originalBytes);

    const vault = {
        configDir: '.obsidian',
        getConfig: () => linkFormat,
        adapter: {
            getBasePath: () => vaultRoot,
            getResourcePath: (path: string) => `app://local/${path}`,
        },
        cachedRead: async () => fs.readFile(absoluteSource, 'utf8'),
    } as unknown as Vault;
    const file = {
        vault,
        path: sourcePath,
        name: 'my deck.md',
        basename: 'my deck',
        parent: { path: 'decks' },
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
    const settings: MarpSlidesSettings = { ...DEFAULT_SETTINGS };
    const manager = new WorkingCopyManager(app, settings, { temporaryDirectory: testRoot });

    return { absoluteSource, file, manager, originalBytes, settings, vaultRoot };
}

const cases: Array<{ type: string; flags: string[]; extension?: string }> = [
    { type: 'pdf', flags: ['--pdf'], extension: 'pdf' },
    { type: 'pdf-with-notes', flags: ['--pdf', '--pdf-notes', '--pdf-outlines'], extension: 'pdf' },
    { type: 'pptx', flags: ['--pptx'], extension: 'pptx' },
    { type: 'png', flags: ['--images', '--png'], extension: 'png' },
    { type: 'html', flags: ['--html', '--template', DEFAULT_SETTINGS.HTMLExportMode], extension: 'html' },
    { type: 'preview', flags: ['--html', '--preview'] },
];

test.each(cases)('$type consumes converted temporary input and preserves output behavior', async ({
    type,
    flags,
    extension,
}) => {
    const fixture = await makeFixture();
    let workingPath = '';
    const cli: MarpCliRunner = jest.fn(async (argv, options) => {
        workingPath = argv[0];
        expect(workingPath).not.toBe(fixture.absoluteSource);
        expect(await fs.readFile(workingPath, 'utf8')).toContain('![image.png](../assets/image.png)');
        expect(options?.baseUrl).toBe(pathToFileURL(`${dirname(fixture.absoluteSource)}${sep}`).href);
        expect(argv).toContain('--allow-local-files');
        for (const flag of flags) {
            expect(argv).toContain(flag);
        }
        if (extension !== undefined) {
            expect(argv.slice(argv.indexOf('-o') + 1)[0]).toBe(
                join(dirname(fixture.absoluteSource), `my deck.${extension}`),
            );
        } else {
            expect(argv).not.toContain('-o');
        }
        return 0;
    });

    await new MarpExport(fixture.settings, fixture.manager, cli).export(fixture.file, type);

    expect(await fs.readFile(fixture.absoluteSource)).toEqual(fixture.originalBytes);
    await expect(fs.stat(workingPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await fixture.manager.dispose();
});

test('retains custom themes, Markdown-it engine and Chrome environment handling', async () => {
    const fixture = await makeFixture();
    fixture.settings.ThemePath = 'themes/custom';
    fixture.settings.EnableMarkdownItPlugins = true;
    fixture.settings.CHROME_PATH = '/browser/custom-chrome';
    const previousChrome = process.env.CHROME_PATH;
    process.env.CHROME_PATH = '/browser/original-chrome';
    const cli: MarpCliRunner = jest.fn(async argv => {
        expect(argv).toEqual(expect.arrayContaining([
            '--theme-set',
            join(fixture.vaultRoot, 'themes', 'custom'),
            '--engine',
            join(fixture.vaultRoot, '.obsidian', 'plugins', 'marp-slides', 'lib3', 'marp.config.js'),
        ]));
        expect(process.env.CHROME_PATH).toBe('/browser/custom-chrome');
        return 0;
    });

    await new MarpExport(fixture.settings, fixture.manager, cli).export(fixture.file, 'html');

    expect(process.env.CHROME_PATH).toBe('/browser/original-chrome');
    process.env.CHROME_PATH = previousChrome;
    await fixture.manager.dispose();
});

test('honors custom output paths for PDF, PPTX and PNG but not HTML', async () => {
    const fixture = await makeFixture();
    fixture.settings.EXPORT_PATH = join(testRoot, 'exports with spaces');
    const outputs: Record<string, string> = {};
    const cli: MarpCliRunner = jest.fn(async argv => {
        outputs[argv.includes('--pdf') ? 'pdf' : argv.includes('--pptx') ? 'pptx' : argv.includes('--images') ? 'png' : 'html'] = argv[argv.indexOf('-o') + 1];
        return 0;
    });
    const exporter = new MarpExport(fixture.settings, fixture.manager, cli);

    await exporter.export(fixture.file, 'pdf');
    await exporter.export(fixture.file, 'pptx');
    await exporter.export(fixture.file, 'png');
    await exporter.export(fixture.file, 'html');

    expect(outputs.pdf).toBe(join(resolve(fixture.settings.EXPORT_PATH), 'my deck.pdf'));
    expect(outputs.pptx).toBe(join(resolve(fixture.settings.EXPORT_PATH), 'my deck.pptx'));
    expect(outputs.png).toBe(join(resolve(fixture.settings.EXPORT_PATH), 'my deck.png'));
    expect(outputs.html).toBe(join(dirname(fixture.absoluteSource), 'my deck.html'));
    await fixture.manager.dispose();
});

test('absolute link mode uses the vault root base without copying or removing a root note', async () => {
    const fixture = await makeFixture('absolute');
    const cli: MarpCliRunner = jest.fn(async (argv, options) => {
        expect(await fs.readFile(argv[0], 'utf8')).toContain('![image.png](assets/image.png)');
        expect(options?.baseUrl).toBe(pathToFileURL(`${fixture.vaultRoot}${sep}`).href);
        return 0;
    });

    await new MarpExport(fixture.settings, fixture.manager, cli).export(fixture.file, 'html');

    await expect(fs.stat(join(fixture.vaultRoot, fixture.file.name))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(fixture.absoluteSource)).toEqual(fixture.originalBytes);
    await fixture.manager.dispose();
});

test('cleans the working copy and preserves source bytes when Marp throws or returns nonzero', async () => {
    for (const behavior of ['throw', 'nonzero']) {
        const fixture = await makeFixture();
        let workingPath = '';
        const cli: MarpCliRunner = jest.fn(async argv => {
            workingPath = argv[0];
            if (behavior === 'throw') {
                throw new Error('renderer failed');
            }
            return 2;
        });
        const exporter = new MarpExport(fixture.settings, fixture.manager, cli);

        await expect(exporter.export(fixture.file, 'pdf')).rejects.toThrow();
        expect(await fs.readFile(fixture.absoluteSource)).toEqual(fixture.originalBytes);
        await expect(fs.stat(workingPath)).rejects.toMatchObject({ code: 'ENOENT' });
        await fixture.manager.dispose();
    }
});

test('does not invoke Marp or stale input when source synchronization fails', async () => {
    const fixture = await makeFixture();
    await fs.rm(fixture.absoluteSource);
    const cli: MarpCliRunner = jest.fn(async () => 0);

    await expect(
        new MarpExport(fixture.settings, fixture.manager, cli).export(fixture.file, 'pdf'),
    ).rejects.toThrow('Unable to create a temporary Marp working copy');
    expect(cli).not.toHaveBeenCalled();
    await fixture.manager.dispose();
});
