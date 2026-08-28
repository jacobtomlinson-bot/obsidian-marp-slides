import { promises as fs } from 'fs';
import { createHash, randomBytes } from 'crypto';
import { get as httpGet, IncomingHttpHeaders } from 'http';
import { get as httpsGet } from 'https';
import { join } from 'path';
import postcss from 'postcss';
import matter from 'gray-matter';

export const REMOTE_THEME_MAX_TTL_MS = 5 * 60 * 1000;
export const REMOTE_THEME_MAX_BYTES = 5 * 1024 * 1024;
export const REMOTE_THEME_REQUEST_TIMEOUT_MS = 15 * 1000;
export const REMOTE_THEME_REDIRECT_LIMIT = 5;

const REMOTE_THEME_NAME_PREFIX = 'obsidian-marp-remote-';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ACCEPTED_CONTENT_TYPES = new Set([
    'application/css',
    'application/octet-stream',
    'application/x-css',
    'text/css',
    'text/plain',
]);

export class RemoteThemeError extends Error {
    constructor(message: string, cause?: unknown) {
        super(message);
        this.name = 'RemoteThemeError';
        if (cause !== undefined) {
            (this as Error & { cause?: unknown }).cause = cause;
        }
    }
}

export interface RemoteTheme {
    readonly url: string;
    readonly finalUrl: string;
    readonly name: string;
    readonly path: string;
    readonly css: string;
}

export interface RemoteThemeHttpResponse {
    readonly status: number;
    readonly headers: Record<string, string>;
    readonly body: Buffer;
    readonly finalUrl: string;
}

export type RemoteThemeHopResponse = Omit<RemoteThemeHttpResponse, 'finalUrl'>;
export type RemoteThemeRequester = (
    url: URL,
    headers: Readonly<Record<string, string>>,
    signal: AbortSignal,
) => Promise<RemoteThemeHopResponse>;

export type RemoteThemeFetcher = (
    url: string,
    headers: Readonly<Record<string, string>>,
    signal: AbortSignal,
) => Promise<RemoteThemeHttpResponse>;

export interface RemoteThemeCacheOptions {
    fetcher?: RemoteThemeFetcher;
    maxTtlMs?: number;
    now?: () => number;
}

interface ThemeVersion {
    readonly theme: RemoteTheme;
    current: boolean;
    references: number;
}

interface CacheEntry {
    readonly url: string;
    version: ThemeVersion;
    validatedAt: number;
    freshUntil: number;
    freshForMs: number;
    etag?: string;
    lastModified?: string;
}

interface InFlightRequest {
    readonly controller: AbortController;
    readonly promise: Promise<ThemeVersion>;
    consumers: number;
    settled: boolean;
}

interface CachePolicy {
    readonly noStore: boolean;
    readonly freshForMs: number;
}

export interface RemoteThemeDirective {
    readonly url: string;
    replace(markdown: string, themeName: string): string;
}

function hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function normalizeHeaders(headers: IncomingHttpHeaders): Record<string, string> {
    const normalized: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
        if (value !== undefined) {
            normalized[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
        }
    }
    return normalized;
}

function validateHttpUrl(url: URL, context: string): void {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new RemoteThemeError(`${context} must use HTTP or HTTPS.`);
    }
    if (url.username !== '' || url.password !== '') {
        throw new RemoteThemeError(`${context} must not contain credentials.`);
    }
}

function withoutFragment(url: URL): URL {
    const normalized = new URL(url.href);
    normalized.hash = '';
    return normalized;
}

function safeUrlForMessage(rawUrl: string): string {
    try {
        const url = new URL(rawUrl);
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        return url.href;
    } catch {
        return 'the configured URL';
    }
}

export function normalizeRemoteThemeUrl(value: string): string | undefined {
    const trimmed = value.trim();
    if (trimmed === '') {
        return undefined;
    }

    // Drive-letter paths and ordinary theme names remain local values.
    if (/^[a-z]:[\\/]/i.test(trimmed) || !/^[a-z][a-z\d+.-]*:/i.test(trimmed)) {
        if (/^https?(?:\s|\/|$)/i.test(trimmed)) {
            throw new RemoteThemeError('Invalid remote theme URL.');
        }
        return undefined;
    }

    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch (error) {
        throw new RemoteThemeError('Invalid remote theme URL.', error);
    }

    validateHttpUrl(parsed, 'Remote theme URL');
    return withoutFragment(parsed).href;
}

function findFrontMatterBounds(markdown: string): { start: number; end: number } | undefined {
    const opening = markdown.match(/^\uFEFF?---[\t ]*\r?\n/);
    if (opening === null) {
        return undefined;
    }
    const rest = markdown.slice(opening[0].length);
    const closing = /^(?:---|\.\.\.)[\t ]*(?:\r?\n|$)/m.exec(rest);
    if (closing === null || closing.index === undefined) {
        return undefined;
    }
    return {
        start: opening[0].length,
        end: opening[0].length + closing.index,
    };
}

function trailingYamlComment(value: string): string {
    const trimmedStart = value.trimStart();
    if (trimmedStart.startsWith('"') || trimmedStart.startsWith("'")) {
        const quote = trimmedStart[0];
        let escaped = false;
        for (let index = 1; index < trimmedStart.length; index++) {
            const character = trimmedStart[index];
            if (quote === '"' && character === '\\' && !escaped) {
                escaped = true;
                continue;
            }
            if (character === quote && !escaped) {
                return trimmedStart.slice(index + 1);
            }
            escaped = false;
        }
        return '';
    }
    const comment = value.match(/([\t ]+#.*)$/);
    return comment?.[1] || '';
}

/** Find an HTTP(S) URL in the deck's top-level YAML `theme` directive. */
export function findRemoteThemeDirective(markdown: string): RemoteThemeDirective | undefined {
    let parsed: matter.GrayMatterFile<string>;
    try {
        parsed = matter(markdown);
    } catch (error) {
        throw new RemoteThemeError('Unable to parse the deck front matter for a remote theme.', error);
    }

    const configuredTheme = parsed.data.theme;
    if (typeof configuredTheme !== 'string') {
        return undefined;
    }
    const url = normalizeRemoteThemeUrl(configuredTheme);
    if (url === undefined) {
        return undefined;
    }

    const bounds = findFrontMatterBounds(markdown);
    if (bounds === undefined) {
        throw new RemoteThemeError('A remote theme URL must be declared in YAML front matter.');
    }
    const frontMatter = markdown.slice(bounds.start, bounds.end);
    const themeLine = /^([\t ]*theme[\t ]*:[\t ]*)(.*)$/m.exec(frontMatter);
    if (themeLine === null || themeLine.index === undefined) {
        throw new RemoteThemeError('Unable to replace the remote theme directive in the working copy.');
    }

    const valueStart = bounds.start + themeLine.index + themeLine[1].length;
    const valueEnd = valueStart + themeLine[2].length;
    const comment = trailingYamlComment(themeLine[2]);
    return {
        url,
        replace: (source, themeName) =>
            `${source.slice(0, valueStart)}${themeName}${comment}${source.slice(valueEnd)}`,
    };
}

function responseContentType(headers: Readonly<Record<string, string>>): string | undefined {
    return headers['content-type']?.split(';')[0].trim().toLowerCase();
}

function validateCssResponse(response: RemoteThemeHttpResponse): string {
    const declaredLength = response.headers['content-length'];
    if (declaredLength !== undefined && Number(declaredLength) > REMOTE_THEME_MAX_BYTES) {
        throw new RemoteThemeError('Remote theme CSS exceeds the 5 MiB download limit.');
    }
    if (response.body.byteLength > REMOTE_THEME_MAX_BYTES) {
        throw new RemoteThemeError('Remote theme CSS exceeds the 5 MiB download limit.');
    }

    const contentType = responseContentType(response.headers);
    if (contentType !== undefined && !ACCEPTED_CONTENT_TYPES.has(contentType)) {
        throw new RemoteThemeError(`Remote theme returned incompatible content type "${contentType}".`);
    }

    const css = response.body.toString('utf8').replace(/^\uFEFF/, '');
    if (/^\s*(?:<!doctype\s+html|<html(?:\s|>))/i.test(css)) {
        throw new RemoteThemeError('Remote theme returned HTML instead of CSS.');
    }
    if (css.trim() === '') {
        throw new RemoteThemeError('Remote theme returned an empty CSS response.');
    }
    try {
        postcss.parse(css, { from: response.finalUrl });
    } catch (error) {
        throw new RemoteThemeError('Remote theme returned invalid CSS.', error);
    }
    return css;
}

function rebaseReference(reference: string, baseUrl: string): string {
    const trimmed = reference.trim();
    if (
        trimmed === '' ||
        trimmed.startsWith('#') ||
        /^(?:data|blob|file|https?):/i.test(trimmed) ||
        trimmed.startsWith('//')
    ) {
        return reference;
    }
    try {
        return new URL(trimmed, baseUrl).href;
    } catch {
        return reference;
    }
}

function rebaseUrlFunctions(
    value: string,
    baseUrl: string,
    shouldRebase: (reference: string) => boolean = () => true,
): string {
    return value.replace(
        /url\(\s*(?:(['"])(.*?)\1|([^)]*?))\s*\)/gi,
        (match, quote: string | undefined, quoted: string | undefined, unquoted: string | undefined) => {
            const reference = quoted === undefined ? unquoted : quoted;
            if (reference === undefined) {
                return match;
            }
            if (!shouldRebase(reference.trim())) {
                return match;
            }
            const rebased = rebaseReference(reference, baseUrl);
            if (rebased === reference) {
                return match;
            }
            const escaped = rebased.replace(/"/g, '\\"');
            return `url("${escaped}")`;
        },
    );
}

function isCssImportPath(reference: string): boolean {
    return /^(?:\.\.?[/\\]|[/\\])/.test(reference) ||
        /[/\\]/.test(reference) ||
        /\.css(?:[?#]|$)/i.test(reference);
}

function rebaseImport(params: string, baseUrl: string): string {
    const rebasedFunctions = rebaseUrlFunctions(params, baseUrl, isCssImportPath);
    if (rebasedFunctions !== params || /^\s*url\(/i.test(params)) {
        return rebasedFunctions;
    }
    return params.replace(/^(\s*)(['"])(.*?)\2/, (match, whitespace, quote, reference) => {
        if (!isCssImportPath(reference)) {
            return match;
        }
        const rebased = rebaseReference(reference, baseUrl);
        return rebased === reference ? match : `${whitespace}${quote}${rebased}${quote}`;
    });
}

export function prepareRemoteThemeCss(css: string, finalUrl: string, themeName: string): string {
    const root = postcss.parse(css, { from: finalUrl });
    root.walkDecls(declaration => {
        declaration.value = rebaseUrlFunctions(declaration.value, finalUrl);
    });
    root.walkAtRules('import', rule => {
        rule.params = rebaseImport(rule.params, finalUrl);
    });
    root.append({ text: `@theme ${themeName}` });
    return root.toString();
}

function parseCachePolicy(headers: Readonly<Record<string, string>>, maxTtlMs: number): CachePolicy {
    const directives = (headers['cache-control'] || '')
        .split(',')
        .map(value => value.trim().toLowerCase());
    const noStore = directives.includes('no-store');
    const noCache = directives.includes('no-cache');
    const maxAgeDirective = directives.find(value => value.startsWith('max-age='));
    const maxAgeSeconds = maxAgeDirective === undefined
        ? undefined
        : Number(maxAgeDirective.slice('max-age='.length).replace(/^"|"$/g, ''));
    const serverTtl = maxAgeSeconds !== undefined && Number.isFinite(maxAgeSeconds) && maxAgeSeconds >= 0
        ? maxAgeSeconds * 1000
        : maxTtlMs;
    return {
        noStore,
        freshForMs: noCache ? 0 : Math.min(maxTtlMs, serverTtl),
    };
}

function abortError(): RemoteThemeError {
    return new RemoteThemeError('Remote theme download was cancelled.');
}

function waitForConsumer<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal === undefined) {
        return promise;
    }
    if (signal.aborted) {
        return Promise.reject(abortError());
    }
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(abortError());
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            value => {
                signal.removeEventListener('abort', onAbort);
                resolve(value);
            },
            error => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            },
        );
    });
}

/**
 * Session-scoped, validator-aware remote theme cache. Published CSS paths are
 * immutable and leased until their preview or export working copy is cleaned.
 */
export class RemoteThemeCache {
    private readonly getSessionRoot: () => Promise<string>;
    private readonly fetcher: RemoteThemeFetcher;
    private readonly maxTtlMs: number;
    private readonly now: () => number;
    private readonly entries = new Map<string, CacheEntry>();
    private readonly versions = new Map<string, ThemeVersion>();
    private readonly inFlight = new Map<string, InFlightRequest>();
    private disposed = false;

    constructor(getSessionRoot: () => Promise<string>, options: RemoteThemeCacheOptions = {}) {
        this.getSessionRoot = getSessionRoot;
        this.fetcher = options.fetcher || fetchRemoteTheme;
        this.maxTtlMs = options.maxTtlMs ?? REMOTE_THEME_MAX_TTL_MS;
        this.now = options.now || Date.now;
    }

    async acquire(url: string, signal?: AbortSignal): Promise<RemoteTheme> {
        if (this.disposed) {
            throw new RemoteThemeError('Cannot acquire a remote theme after temporary cleanup.');
        }
        if (signal?.aborted) {
            throw abortError();
        }
        const entry = this.entries.get(url);
        const now = this.now();
        if (entry !== undefined && now >= entry.validatedAt && now < entry.freshUntil) {
            return this.retain(entry.version);
        }

        let request = this.inFlight.get(url);
        if (request === undefined) {
            const controller = new AbortController();
            const promise = this.refresh(url, entry, controller.signal);
            request = { controller, promise, consumers: 0, settled: false };
            this.inFlight.set(url, request);
            promise.then(
                () => this.finishRequest(url, request as InFlightRequest),
                () => this.finishRequest(url, request as InFlightRequest),
            );
        }

        request.consumers++;
        try {
            const version = await waitForConsumer(request.promise, signal);
            return this.retain(version);
        } finally {
            request.consumers--;
            if (request.consumers === 0 && !request.settled) {
                request.controller.abort();
            }
        }
    }

    async release(theme: RemoteTheme): Promise<void> {
        const version = this.versions.get(theme.path);
        if (version === undefined || version.theme !== theme || version.references === 0) {
            return;
        }
        version.references--;
        if (!version.current && version.references === 0) {
            await this.removeVersion(version);
        }
    }

    async dispose(): Promise<void> {
        this.disposed = true;
        for (const request of this.inFlight.values()) {
            request.controller.abort();
        }
    }

    private finishRequest(url: string, request: InFlightRequest): void {
        request.settled = true;
        if (this.inFlight.get(url) === request) {
            this.inFlight.delete(url);
        }
    }

    private retain(version: ThemeVersion): RemoteTheme {
        if (!this.versions.has(version.theme.path)) {
            throw new RemoteThemeError('Remote theme cache entry is no longer available.');
        }
        version.references++;
        return version.theme;
    }

    private async refresh(
        url: string,
        previous: CacheEntry | undefined,
        signal: AbortSignal,
    ): Promise<ThemeVersion> {
        const headers: Record<string, string> = {};
        if (previous?.etag !== undefined) {
            headers['If-None-Match'] = previous.etag;
        }
        if (previous?.lastModified !== undefined) {
            headers['If-Modified-Since'] = previous.lastModified;
        }

        let response: RemoteThemeHttpResponse;
        try {
            response = await this.fetcher(url, headers, signal);
        } catch (error) {
            if (error instanceof RemoteThemeError) {
                throw error;
            }
            throw new RemoteThemeError(
                `Unable to download the remote theme from ${safeUrlForMessage(url)}.`,
                error,
            );
        }
        if (this.disposed || signal.aborted) {
            throw abortError();
        }

        const validatedAt = this.now();
        if (response.status === 304) {
            if (previous === undefined) {
                throw new RemoteThemeError('Remote theme returned 304 without a cached version.');
            }
            const policy = response.headers['cache-control'] === undefined
                ? { noStore: false, freshForMs: previous.freshForMs }
                : parseCachePolicy(response.headers, this.maxTtlMs);
            previous.validatedAt = validatedAt;
            previous.freshUntil = validatedAt + policy.freshForMs;
            previous.freshForMs = policy.freshForMs;
            previous.etag = response.headers.etag || previous.etag;
            previous.lastModified = response.headers['last-modified'] || previous.lastModified;
            if (policy.noStore) {
                this.entries.delete(url);
                previous.version.current = false;
            }
            return previous.version;
        }
        if (response.status < 200 || response.status >= 300) {
            throw new RemoteThemeError(`Remote theme request failed with HTTP ${response.status}.`);
        }

        const css = validateCssResponse(response);
        const urlHash = hash(url);
        const themeName = `${REMOTE_THEME_NAME_PREFIX}${urlHash.slice(0, 20)}`;
        const preparedCss = prepareRemoteThemeCss(css, response.finalUrl, themeName);
        const theme = await this.publish(url, response.finalUrl, themeName, preparedCss);
        const existingVersion = this.versions.get(theme.path);
        const version = existingVersion !== undefined
            ? existingVersion
            : { theme, current: true, references: 0 };
        version.current = true;
        this.versions.set(theme.path, version);

        const policy = parseCachePolicy(response.headers, this.maxTtlMs);
        if (previous !== undefined && previous.version !== version) {
            previous.version.current = false;
        }
        if (policy.noStore) {
            version.current = false;
            this.entries.delete(url);
        } else {
            this.entries.set(url, {
                url,
                version,
                validatedAt,
                freshUntil: validatedAt + policy.freshForMs,
                freshForMs: policy.freshForMs,
                etag: response.headers.etag,
                lastModified: response.headers['last-modified'],
            });
        }
        if (
            previous !== undefined &&
            previous.version !== version &&
            previous.version.references === 0
        ) {
            await this.removeVersion(previous.version);
        }
        return version;
    }

    private async publish(
        url: string,
        finalUrl: string,
        name: string,
        css: string,
    ): Promise<RemoteTheme> {
        const root = await this.getSessionRoot();
        const directory = join(root, 'themes');
        await fs.mkdir(directory, { recursive: true });
        const path = join(directory, `${hash(url)}-${hash(css)}.css`);
        const partial = join(directory, `.${hash(url)}-${randomBytes(8).toString('hex')}.tmp`);
        try {
            await fs.writeFile(partial, css, 'utf8');
            try {
                await fs.rename(partial, path);
            } catch (error) {
                const existing = await fs.stat(path).catch(() => undefined);
                if (existing === undefined) {
                    throw error;
                }
                await fs.rm(partial, { force: true });
            }
        } catch (error) {
            await fs.rm(partial, { force: true }).catch(() => undefined);
            throw new RemoteThemeError(
                `Unable to publish the downloaded theme from ${safeUrlForMessage(url)}.`,
                error,
            );
        }
        return { url, finalUrl, name, path, css };
    }

    private async removeVersion(version: ThemeVersion): Promise<void> {
        if (!this.versions.has(version.theme.path) || version.current || version.references !== 0) {
            return;
        }
        try {
            await fs.rm(version.theme.path, { force: true });
            this.versions.delete(version.theme.path);
        } catch (error) {
            console.error(`Unable to clean remote theme "${version.theme.path}".`, error);
        }
    }
}

function requestOnce(
    url: URL,
    headers: Readonly<Record<string, string>>,
    signal: AbortSignal,
): Promise<RemoteThemeHopResponse> {
    return new Promise((resolve, reject) => {
        const client = url.protocol === 'https:' ? httpsGet : httpGet;
        let settled = false;
        const fail = (error: unknown) => {
            if (!settled) {
                settled = true;
                reject(error);
            }
        };
        const timer = setTimeout(() => {
            fail(new RemoteThemeError('Remote theme request timed out.'));
            request.destroy();
        }, REMOTE_THEME_REQUEST_TIMEOUT_MS);
        const onAbort = () => {
            fail(abortError());
            request.destroy();
        };
        signal.addEventListener('abort', onAbort, { once: true });

        const request = client(url, {
            headers: {
                Accept: 'text/css, text/plain;q=0.9, application/octet-stream;q=0.5',
                ...headers,
            },
        }, response => {
            const responseHeaders = normalizeHeaders(response.headers);
            const declaredLength = responseHeaders['content-length'];
            if (declaredLength !== undefined && Number(declaredLength) > REMOTE_THEME_MAX_BYTES) {
                response.resume();
                fail(new RemoteThemeError('Remote theme CSS exceeds the 5 MiB download limit.'));
                request.destroy();
                return;
            }

            const chunks: Buffer[] = [];
            let length = 0;
            response.on('data', (chunk: Buffer | string) => {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                length += buffer.byteLength;
                if (length > REMOTE_THEME_MAX_BYTES) {
                    fail(new RemoteThemeError('Remote theme CSS exceeds the 5 MiB download limit.'));
                    request.destroy();
                    return;
                }
                chunks.push(buffer);
            });
            response.on('error', fail);
            response.on('end', () => {
                if (settled) {
                    return;
                }
                settled = true;
                resolve({
                    status: response.statusCode || 0,
                    headers: responseHeaders,
                    body: Buffer.concat(chunks),
                });
            });
        });
        request.setTimeout(10_000, () => {
            fail(new RemoteThemeError('Remote theme connection timed out.'));
            request.destroy();
        });
        request.on('error', fail);
        request.on('close', () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
        });
    });
}

export function validateRemoteThemeRedirect(from: URL, to: URL): void {
    validateHttpUrl(to, 'Remote theme redirect');
    if (from.protocol === 'https:' && to.protocol !== 'https:') {
        throw new RemoteThemeError('Remote theme redirect cannot downgrade HTTPS to HTTP.');
    }
}

/** HTTP client with bounded redirects, response size, timeout, and cancellation. */
export async function fetchRemoteTheme(
    rawUrl: string,
    initialHeaders: Readonly<Record<string, string>>,
    signal: AbortSignal,
): Promise<RemoteThemeHttpResponse> {
    return fetchRemoteThemeWith(requestOnce, rawUrl, initialHeaders, signal);
}

export async function fetchRemoteThemeWith(
    requester: RemoteThemeRequester,
    rawUrl: string,
    initialHeaders: Readonly<Record<string, string>>,
    signal: AbortSignal,
): Promise<RemoteThemeHttpResponse> {
    let current = withoutFragment(new URL(rawUrl));
    validateHttpUrl(current, 'Remote theme URL');
    let headers = { ...initialHeaders };

    for (let redirects = 0; redirects <= REMOTE_THEME_REDIRECT_LIMIT; redirects++) {
        const response = await requester(current, headers, signal);
        if (!REDIRECT_STATUSES.has(response.status)) {
            return { ...response, finalUrl: current.href };
        }
        const location = response.headers.location;
        if (location === undefined) {
            throw new RemoteThemeError(`Remote theme redirect HTTP ${response.status} has no location.`);
        }
        if (redirects === REMOTE_THEME_REDIRECT_LIMIT) {
            throw new RemoteThemeError('Remote theme exceeded the redirect limit.');
        }
        const next = withoutFragment(new URL(location, current));
        validateRemoteThemeRedirect(current, next);
        if (next.origin !== current.origin) {
            headers = {};
        }
        current = next;
    }
    throw new RemoteThemeError('Remote theme exceeded the redirect limit.');
}
