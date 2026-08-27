# Obsidian Marp Slides - Technical Documentation

> For user documentation and getting started guides, see [README.md](README.md) and the [online documentation](https://samuele-cozzi.github.io/obsidian-marp-slides/).

## Overview

**Obsidian Marp Slides** is a plugin that integrates [Marp](https://marp.app/) (Markdown Presentation Ecosystem) into [Obsidian](https://obsidian.md/), enabling users to create, preview, and export slide presentations directly from Markdown files.

| Property | Value |
|----------|-------|
| Plugin ID | `marp-slides` |
| Version | 0.46.1 |
| Author | Samuele Cozzi |
| License | MIT |
| Min Obsidian Version | 0.15.0 |

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Obsidian App                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────┐    ┌──────────────────┐    ┌───────────────┐  │
│  │  MarpSlides │───▶│  MarpPreviewView │───▶│   Marp Core   │  │
│  │   (Plugin)  │    │    (ItemView)    │    │   (Renderer)  │  │
│  └──────┬──────┘    └──────────────────┘    └───────────────┘  │
│         │                                                       │
│         │           ┌──────────────────┐    ┌───────────────┐  │
│         └──────────▶│    MarpExport    │───▶│   Marp CLI    │  │
│                     │   (Exporter)     │    │   (Export)    │  │
│                     └────────┬─────────┘    └───────────────┘  │
│                              │                                  │
│                     ┌────────▼─────────┐                       │
│                     │     FilePath     │                       │
│                     │   (Utilities)    │                       │
│                     └──────────────────┘                       │
│                                                                 │
│  Preview and export both consume snapshots owned by             │
│  WorkingCopyManager; vault notes are never used as writable     │
│  Marp inputs.                                                    │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow

**Preview Pipeline:**
1. User opens Markdown file and triggers "Slide Preview" command
2. `MarpSlides` retrieves active `MarkdownView` and creates `MarpPreviewView`
3. `WorkingCopyManager` writes a converted, unique snapshot outside the vault
4. `MarpPreviewView` reads that snapshot and uses Marp Core to render Markdown → HTML/CSS
5. Rendered slides use the original note or vault base path for assets
6. Modify, file-open, rename, and delete events refresh or clear the preview; generation checks discard late work

**Export Pipeline:**
1. User triggers export command (PDF/HTML/PPTX/PNG)
2. The shared `WorkingCopyManager` snapshots and converts the current note
3. `FilePath` resolves the original resource base, themes, and explicit user-visible output path
4. The shared `MarpExport` invokes Marp CLI with the temporary input and original base URL
5. Marp CLI uses Chrome/Chromium for PDF/PPTX rendering
6. The operation removes its owned temporary directory in `finally`, on success or failure

---

## Project Structure

```
obsidian-marp-slides/
├── src/
│   ├── main.ts                      # Plugin entry point, commands, settings
│   ├── config/
│   │   └── marp.config.js           # Marp engine configuration for markdown-it plugins
│   ├── utilities/
│   │   ├── settings.ts              # Settings interface and defaults
│   │   ├── marpExport.ts            # Export functionality (PDF, HTML, PPTX, PNG)
│   │   ├── filePath.ts              # File/path resolution utilities
│   │   ├── workingCopy.ts           # Isolated temporary Markdown snapshots
│   │   ├── libs.ts                  # External library management
│   │   └── icons.ts                 # SVG icon definitions
│   └── views/
│       └── marpPreviewView.ts       # Slide preview rendering
├── tests/
│   ├── filePath.test.ts             # Path and wiki-image conversion tests
│   ├── workingCopy.test.ts           # Isolation, immutability, and cleanup tests
│   ├── marpExport.test.ts            # Export parity and failure tests
│   ├── marpPreviewView.test.ts       # Preview refresh and race tests
│   └── __mocks__/
│       └── obsidian.ts              # Obsidian API mocks
├── docs/                            # User documentation
├── vault/samples/                   # Sample presentations
├── .github/workflows/
│   └── release-please.yml           # CI/CD pipeline
├── esbuild.config.mjs               # Build configuration
├── tsconfig.json                    # TypeScript configuration
├── jest.config.js                   # Test configuration
├── package.json                     # Dependencies and scripts
├── manifest.json                    # Obsidian plugin metadata
├── styles.css                       # Plugin styling
└── version-bump.mjs                 # Version management script
```

---

## Core Components

### MarpSlides (`src/main.ts`)

Main plugin class extending Obsidian's `Plugin`.

**Responsibilities:**
- Plugin lifecycle management (`onload`, `onunload`)
- Command registration (preview, export)
- Settings management
- Shared working-copy/export lifecycle
- Event listeners (modify, open, rename, delete, cursor position)

**Key Methods:**
| Method | Description |
|--------|-------------|
| `onload()` | Initializes shared services and registers views, commands, and events |
| `showPreviewSlide()` | Opens and initializes the preview pane |
| `exportFile()` | Exports the active note through the shared exporter |
| `onChange()` | Refreshes the displayed note after modification |
| `onFileOpen()` | Switches or clears preview state with the active note |

**Registered Commands:**
- `marp-slides:preview` - Slide Preview
- `marp-slides:export-pdf` - Export PDF
- `marp-slides:export-pdf-notes` - Export PDF with Notes
- `marp-slides:export-html` - Export HTML
- `marp-slides:export-pptx` - Export PPTX
- `marp-slides:export-png` - Export PNG

---

### MarpPreviewView (`src/views/marpPreviewView.ts`)

Custom view for rendering slides, extending Obsidian's `ItemView`.

**Responsibilities:**
- Marp Core initialization and configuration
- Theme loading from vault
- Working-copy refresh and slide rendering (Markdown → HTML)
- Generation-based stale refresh rejection
- Working-copy cleanup on switch, failure, clear, and close
- Cursor-to-slide synchronization
- Export action buttons

**Key Methods:**
| Method | Description |
|--------|-------------|
| `onOpen()` | Initializes the container and loads themes |
| `displaySlides()` | Refreshes the working copy and renders it when its generation is current |
| `clear()` / `onClose()` | Invalidates state and releases the displayed working copy |
| `onLineChanged()` | Scrolls to a slide based on the cursor |
| `addActions()` | Adds guarded export buttons to the view header |

**Marp Configuration:**
```typescript
new Marp({
    container: { tag: 'div', id: '__marp-vscode' },
    slideContainer: { tag: 'div', 'data-marp-vscode-slide-wrapper': '' },
    html: this.settings.EnableHTML,
    inlineSVG: { enabled: true, backdropSelector: false },
    math: this.settings.MathTypesettings,
    minifyCSS: true,
    script: false
});
```

---

### MarpExport (`src/utilities/marpExport.ts`)

Handles exporting presentations to various formats.

**Responsibilities:**
- Building Marp CLI argument arrays
- Creating and cleaning one-shot temporary inputs
- Preserving the original asset base URL and export destination
- Managing export types and options
- Browser path resolution
- Serialized process-global CLI state and surfaced failures

**Key Methods:**
| Method | Description |
|--------|-------------|
| `export()` | Creates an operation snapshot, invokes Marp, and cleans in `finally` |
| `run()` | Serializes process-global environment changes around the CLI call |
| `runMarpCli()` | Executes Marp CLI with the original resource base URL |

**Supported Export Types:**
| Type | CLI Flags | Output |
|------|-----------|--------|
| `pdf` | `--pdf` | PDF file |
| `pdf-with-notes` | `--pdf --pdf-notes --pdf-outlines` | PDF with speaker notes |
| `pptx` | `--pptx` | PowerPoint file |
| `png` | `--images --png` | PNG images |
| `html` | `--html --template [mode]` | HTML file |
| `preview` | `--html --preview` | Opens generated HTML in a browser |

---

### WorkingCopyManager (`src/utilities/workingCopy.ts`)

Creates collision-safe, per-refresh Markdown snapshots beneath a random
plugin-owned directory in the operating system's temporary directory. It
converts resolvable Obsidian image embeds only in those snapshots, tracks exact
ownership for safe cleanup, and never writes, renames, copies, or removes the
source vault note.

Preview snapshots remain alive only while displayed. Export snapshots remain
alive only until the awaited Marp CLI call settles. A new directory per refresh
also prevents late writes or notes with identical basenames from colliding.

---

### FilePath (`src/utilities/filePath.ts`)

Utility class for file and path resolution.

**Responsibilities:**
- Vault base path resolution
- Absolute vs relative link format handling
- Original-note base URL and output-path resolution
- Obsidian image embed conversion with URL-safe paths
- Theme directory resolution
- Plugin directory management

**Key Methods:**
| Method | Description |
|--------|-------------|
| `getCompleteFileBasePath()` | Gets the Obsidian preview resource base |
| `getSourceFilePath()` | Gets the original note's physical path without relocating it |
| `getMarpBaseUrl()` | Keeps relative resources based at the source folder or vault root |
| `getExportPath()` | Directs output away from the temporary input directory |
| `convertImageWikiLinks()` | Converts only resolved image embeds in a supplied snapshot |
| `getThemePath()` | Resolves custom theme directory |

---

### MarpSlidesSettings (`src/utilities/settings.ts:1-21`)

Settings interface and defaults.

```typescript
interface MarpSlidesSettings {
    CHROME_PATH: string;           // Custom browser path for export
    ThemePath: string;             // Custom theme CSS directory
    EnableHTML: boolean;           // Allow HTML in Markdown
    MathTypesettings: string;      // 'mathjax' or 'katex'
    HTMLExportMode: string;        // 'bare' or 'bespoke'
    EXPORT_PATH: string;           // Custom export output directory
    EnableSyncPreview: boolean;    // Sync preview with cursor
    EnableMarkdownItPlugins: boolean; // Enable markdown-it extensions
}
```

**Default Values:**
| Setting | Default |
|---------|---------|
| CHROME_PATH | `''` (auto-detect) |
| ThemePath | `''` (none) |
| EnableHTML | `false` |
| MathTypesettings | `'mathjax'` |
| HTMLExportMode | `'bare'` |
| EXPORT_PATH | `''` (same as source) |
| EnableSyncPreview | `true` |
| EnableMarkdownItPlugins | `false` |

---

### Libs (`src/utilities/libs.ts:8-61`)

Manages external markdown-it plugin libraries.

**Responsibilities:**
- Check if libraries exist locally
- Download compiled plugins from GitHub releases
- Extract ZIP archive and cache plugins

**Library Source:** `https://github.com/samuele-cozzi/obsidian-marp-slides/releases/download/lib-v3/lib.zip`

**Included Plugins:**
- `markdown-it-container` - Custom containers
- `markdown-it-mark` - Text highlighting
- `markdown-it-kroki` - Diagram rendering via Kroki.io

---

### LineSelectionListener (`src/main.ts`)

Experimental feature for cursor-to-slide synchronization.

**Implementation:** Extends `EditorSuggest` (non-intrusive approach to track cursor)

**How it works:**
1. Listens to cursor position changes
2. Counts slide separators (`---`) before cursor
3. Parses YAML frontmatter to adjust slide count
4. Scrolls preview to corresponding slide

---

## Technology Stack

### Runtime Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@marp-team/marp-core` | ^3.9.0 | Core slide rendering engine |
| `@marp-team/marp-cli` | ^2.5.0 | Export engine (PDF, PPTX, HTML, PNG) |
| `@marp-team/marpit` | ^2.6.1 | Markdown presentation framework |
| `gray-matter` | ^4.0.3 | YAML frontmatter parsing |
| `fs-extra` | ^11.2.0 | Extended file system operations |
| `jszip` | ^3.10.1 | ZIP handling for library distribution |
| `request` | ^2.88.2 | HTTP requests for library download |

### Development Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `typescript` | ^4.9.5 | Type-safe development |
| `esbuild` | 0.17.3 | Fast bundler |
| `jest` | ^29.7.0 | Testing framework |
| `ts-jest` | ^29.1.2 | TypeScript support for Jest |
| `obsidian` | ^1.5.7-1 | Obsidian API types |
| `@typescript-eslint/*` | 5.29.0 | Linting |

### External Requirements

- **Chrome/Chromium/Edge** - Required for PDF, PPTX, and PNG export
- **Node.js** - Development and build environment

---

## Development Setup

### Prerequisites

- Node.js (v16+)
- npm
- Obsidian (for testing)

### Installation

```bash
# Clone the repository
git clone https://github.com/samuele-cozzi/obsidian-marp-slides.git
cd obsidian-marp-slides

# Install dependencies
npm install
```

### Build Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Watch mode with inline sourcemaps |
| `npm run build` | TypeScript check + production build |
| `npm run test` | Run tests with coverage |
| `npm run test:watch` | Run tests in watch mode |
| `npm run version` | Bump version in manifest |

### Development Workflow

1. **Start watch mode:**
   ```bash
   npm run dev
   ```

2. **Link to Obsidian vault:**
   - Copy or symlink the project directory to your vault's `.obsidian/plugins/marp-slides/`
   - Or set up the vault's plugin directory to point to your development folder

3. **Enable plugin:**
   - Open Obsidian Settings → Community Plugins
   - Enable "Marp Slides"
   - Use "Reload app without saving" (Ctrl/Cmd+R) after changes

4. **Debug:**
   - Open Developer Tools (Ctrl/Cmd+Shift+I)
   - Check Console for logs and errors

### Build Configuration (`esbuild.config.mjs`)

- **Entry:** `main.ts`
- **Output:** `main.js`
- **Format:** CommonJS
- **Target:** ES2018
- **External:** `obsidian`, `electron`, `@codemirror/*`
- **Production:** Minified, no sourcemap
- **Development:** Inline sourcemap

---

## Testing

### Framework

- **Jest** with **ts-jest** preset
- Coverage reporting via **lcov**
- Mocks for Obsidian API

### Running Tests

```bash
# Run all tests with coverage
npm run test

# Watch mode
npm run test:watch
```

### Test Structure

```
tests/
├── filePath.test.ts      # Path resolution tests
├── coverage/             # Coverage reports (generated)
└── __mocks__/
    └── obsidian.ts       # Obsidian API mocks
```

### Coverage

Coverage reports are generated in `tests/coverage/` and uploaded to CodeClimate during CI.

---

## CI/CD Pipeline

### GitHub Actions Workflow (`.github/workflows/release-please.yml`)

**Trigger:** Push to `main` branch

### Jobs

#### 1. release-please
- Uses `google-github-actions/release-please-action@v3`
- Analyzes commits for version bump
- Creates release PR if warranted
- Generates changelog in `docs/CHANGELOG.md`

#### 2. release-plugin (if release created)
1. Updates `manifest.json` version
2. Commits version update
3. Builds plugin (`npm install && npm run build`)
4. Runs tests with CodeClimate coverage upload
5. Packages artifacts:
   - `main.js`
   - `manifest.json`
   - `styles.css`
   - `obsidian-marp-slides-{version}.zip`
6. Uploads to GitHub release

### Release Artifacts

| File | Description |
|------|-------------|
| `main.js` | Compiled plugin code |
| `manifest.json` | Plugin metadata |
| `styles.css` | Plugin styling |
| `obsidian-marp-slides-{version}.zip` | Complete plugin package |

---

## Configuration Options Reference

### CHROME_PATH
**Type:** `string` | **Default:** `''`

Custom path to Chrome, Chromium, or Edge browser for PDF/PPTX/PNG export. If empty, Marp CLI auto-detects installed browsers.

### ThemePath
**Type:** `string` | **Default:** `''`

Vault-relative path to directory containing custom Marp theme CSS files. Themes are loaded on preview open.

### EXPORT_PATH
**Type:** `string` | **Default:** `''`

Custom output directory for exports. If empty, exports to same directory as source file. Does not affect HTML export.

### EnableHTML
**Type:** `boolean` | **Default:** `false`

Allow HTML elements in Marp Markdown. Use with caution.

### MathTypesettings
**Type:** `'mathjax' | 'katex'` | **Default:** `'mathjax'`

Math rendering library. Can be overridden per-slide via frontmatter.

### HTMLExportMode
**Type:** `'bare' | 'bespoke'` | **Default:** `'bare'`

HTML export template. `bespoke` is experimental and provides interactive features.

### EnableSyncPreview
**Type:** `boolean` | **Default:** `true`

(Experimental) Synchronize slide preview with editor cursor position.

### EnableMarkdownItPlugins
**Type:** `boolean` | **Default:** `false`

(Experimental) Enable markdown-it plugins for containers, marks, and Kroki diagrams.

---

## Obsidian API Integration

### Used APIs

| API | Usage |
|-----|-------|
| `Plugin` | Base class for plugin |
| `ItemView` | Custom preview view |
| `MarkdownView` | Access editor content |
| `PluginSettingTab` | Settings UI |
| `EditorSuggest` | Cursor position tracking |
| `Vault` | File operations |
| `FileSystemAdapter` | Path resolution |
| `WorkspaceLeaf` | View management |

### Registered Entities

| Type | ID/Name |
|------|---------|
| View | `marp-preview-view` |
| Icons | `slides-preview-marp`, `slides-marp-export-pdf`, `slides-marp-export-pptx`, `slides-marp-slide-present` |
| Commands | 6 commands (see MarpSlides section) |
| Ribbon | Preview button |

---

## Known Limitations

- **Wiki Links** not supported in slides
- **Mobile App** plugin is in alpha state
- **Export** (except HTML) requires Chrome/Chromium/Edge installed
- **Sync Preview** is experimental and may have edge cases

---

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make changes with tests
4. Submit a pull request

For bug reports and feature requests, use [GitHub Issues](https://github.com/samuele-cozzi/obsidian-marp-slides/issues).
