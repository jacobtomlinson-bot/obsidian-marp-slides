import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import postcss from 'postcss';
import {
    fetchRemoteThemeWith,
    findRemoteThemeDirective,
    normalizeRemoteThemeUrl,
    prepareRemoteThemeCss,
    RemoteThemeCache,
    RemoteThemeFetcher,
    RemoteThemeFileSystem,
    RemoteThemeHttpResponse,
    RemoteThemeRequester,
    REMOTE_THEME_MAX_BYTES,
    REMOTE_THEME_MAX_TTL_MS,
    validateRemoteThemeRedirect,
} from '../src/utilities/remoteTheme';

let testRoot: string;

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, reject, resolve };
}

beforeEach(async () => {
    testRoot = await fs.mkdtemp(join(tmpdir(), 'marp-remote-theme-test-'));
});

afterEach(async () => {
    await fs.rm(testRoot, { recursive: true, force: true });
});

function response(
    css: string,
    headers: Record<string, string> = { 'content-type': 'text/css' },
    status = 200,
    finalUrl = 'https://cdn.example.com/themes/deck.css',
): RemoteThemeHttpResponse {
    return {
        status,
        headers,
        body: Buffer.from(css),
        finalUrl,
        validatorsSent: status === 304,
    };
}

function remoteFileSystem(
    overrides: Partial<RemoteThemeFileSystem> = {},
): RemoteThemeFileSystem {
    return {
        mkdir: (path, options) => fs.mkdir(path, options),
        rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
        rm: (path, options) => fs.rm(path, options),
        stat: path => fs.stat(path),
        writeFile: (path, data, encoding) => fs.writeFile(path, data, encoding),
        ...overrides,
    };
}

test('classifies only safe HTTP(S) theme URLs and ignores local theme values', () => {
    expect(normalizeRemoteThemeUrl('  HTTPS://Example.COM/theme.css?q=one#old  '))
        .toBe('https://example.com/theme.css?q=one');
    expect(normalizeRemoteThemeUrl('gaia')).toBeUndefined();
    expect(normalizeRemoteThemeUrl('themes/custom.css')).toBeUndefined();
    expect(normalizeRemoteThemeUrl('https-inspired')).toBeUndefined();
    expect(normalizeRemoteThemeUrl('//vault/themes/custom.css')).toBeUndefined();
    expect(normalizeRemoteThemeUrl('C:\\themes\\custom.css')).toBeUndefined();
    expect(() => normalizeRemoteThemeUrl('file:///tmp/theme.css')).toThrow('must use HTTP or HTTPS');
    expect(() => normalizeRemoteThemeUrl('data:text/css,section{}')).toThrow('must use HTTP or HTTPS');
    expect(() => normalizeRemoteThemeUrl('https://user:secret@example.com/theme.css'))
        .toThrow('must not contain credentials');
    expect(() => normalizeRemoteThemeUrl('https://')).toThrow('Invalid remote theme URL');
});

test('rewrites a URL theme only in the working snapshot and preserves YAML comments', () => {
    const markdown = [
        '---',
        'marp: true',
        'theme: "https://cdn.example.com/theme.css?q=1#release" # remote',
        '---',
        '# Deck',
    ].join('\r\n');
    const directive = findRemoteThemeDirective(markdown);

    expect(directive?.url).toBe('https://cdn.example.com/theme.css?q=1');
    expect(directive?.replace(markdown, 'cached-theme')).toContain(
        'theme: cached-theme # remote',
    );
    expect(findRemoteThemeDirective('---\ntheme: gaia\n---\n# Deck')).toBeUndefined();

    const nested = [
        '---',
        'meta:',
        '  theme: local',
        'theme: https://cdn.example.com/top.css',
        '---',
    ].join('\n');
    const nestedDirective = findRemoteThemeDirective(nested);
    expect(nestedDirective?.replace(nested, 'cached-top')).toContain(
        'meta:\n  theme: local\ntheme: cached-top',
    );
    expect(() => findRemoteThemeDirective([
        '---',
        'theme: >',
        '  https://cdn.example.com/folded.css',
        '---',
    ].join('\n'))).toThrow('single-line, top-level YAML theme scalar');
    expect(() => findRemoteThemeDirective([
        '---',
        'theme: &remote https://example.com/a.css',
        'copy: *remote',
        '---',
    ].join('\n'))).toThrow('without YAML decorations');
    expect(() => findRemoteThemeDirective([
        '---',
        'theme: !!str https://example.com/tagged.css',
        '---',
    ].join('\n'))).toThrow('without YAML decorations');
});

test('caches fresh CSS, conditionally revalidates, and publishes immutable updated versions', async () => {
    let now = 1_000;
    const calls: Array<{ headers: Readonly<Record<string, string>>; url: string }> = [];
    const responses = [
        response(
            '@import "default"; @import "./base.css"; section { background: url("../images/one space.png"); }',
            {
                'cache-control': 'max-age=3600',
                'content-type': 'text/css',
                etag: '"one"',
                'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT',
            },
        ),
        response('', { 'cache-control': 'max-age=30' }, 304),
        response('section { color: blue; }', {
            'content-type': 'text/css',
            etag: '"two"',
        }),
    ];
    const fetcher: RemoteThemeFetcher = jest.fn(async (url, headers) => {
        calls.push({ url, headers: { ...headers } });
        return responses.shift() as RemoteThemeHttpResponse;
    });
    const cache = new RemoteThemeCache(async () => testRoot, { fetcher, now: () => now });
    const url = 'https://cdn.example.com/themes/deck.css?variant=wide';

    const first = await cache.acquire(url);
    expect(first.path.startsWith(join(testRoot, 'themes'))).toBe(true);
    expect(first.css).toContain('https://cdn.example.com/themes/base.css');
    expect(first.css).toContain('@import "default"');
    expect(first.css).toContain('https://cdn.example.com/images/one%20space.png');
    expect(first.css).toContain(`@theme ${first.name}`);
    expect(await fs.readFile(first.path, 'utf8')).toBe(first.css);
    await cache.release(first);

    now += REMOTE_THEME_MAX_TTL_MS - 1;
    const fresh = await cache.acquire(url);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fresh.path).toBe(first.path);
    await cache.release(fresh);

    now += 2;
    const unchanged = await cache.acquire(url);
    expect(calls[1].headers).toEqual({
        'If-Modified-Since': 'Wed, 01 Jan 2025 00:00:00 GMT',
        'If-None-Match': '"one"',
    });
    expect(unchanged.path).toBe(first.path);
    expect(unchanged.css).toBe(first.css);
    await cache.release(unchanged);

    now += 30_001;
    const updated = await cache.acquire(url);
    expect(updated.path).not.toBe(first.path);
    expect(updated.css).toContain('color: blue');
    await expect(fs.stat(first.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await cache.release(updated);
    await cache.dispose();
});

test('keeps an old immutable version until its final lease is released', async () => {
    let now = 0;
    const fetcher = jest.fn()
        .mockResolvedValueOnce(response('section { color: red }', { 'content-type': 'text/css' }))
        .mockResolvedValueOnce(response('section { color: blue }', { 'content-type': 'text/css' }));
    const cache = new RemoteThemeCache(async () => testRoot, { fetcher, maxTtlMs: 10, now: () => now });
    const url = 'https://one.example/theme.css';

    const oldLease = await cache.acquire(url);
    now = 11;
    const newLease = await cache.acquire(url);

    expect(newLease.path).not.toBe(oldLease.path);
    expect(await fs.stat(oldLease.path)).toBeDefined();
    await cache.release(oldLease);
    await expect(fs.stat(oldLease.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await cache.release(newLease);
});

test('honors no-cache and no-store without silently retaining stale CSS', async () => {
    let call = 0;
    const fetcher: RemoteThemeFetcher = jest.fn(async () => {
        call++;
        return response(`section { --call: ${call} }`, {
            'cache-control': call <= 2 ? 'no-cache' : 'no-store',
            'content-type': 'text/css',
        });
    });
    const cache = new RemoteThemeCache(async () => testRoot, { fetcher });
    const url = 'https://cache.example/theme.css';

    const first = await cache.acquire(url);
    await cache.release(first);
    const second = await cache.acquire(url);
    expect(second.css).not.toBe(first.css);
    await cache.release(second);
    const noStore = await cache.acquire(url);
    const noStorePath = noStore.path;
    await cache.release(noStore);
    await expect(fs.stat(noStorePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await cache.acquire(url);
    expect(fetcher).toHaveBeenCalledTimes(4);
});

test('retains the previous short freshness policy when a 304 omits Cache-Control', async () => {
    let now = 0;
    const fetcher = jest.fn()
        .mockResolvedValueOnce(response('section {}', {
            'cache-control': 'max-age=1',
            'content-type': 'text/css',
            etag: '"same"',
        }))
        .mockResolvedValueOnce(response('', {}, 304))
        .mockResolvedValueOnce(response('', {}, 304));
    const cache = new RemoteThemeCache(async () => testRoot, { fetcher, now: () => now });
    const url = 'https://short.example/theme.css';

    await cache.release(await cache.acquire(url));
    now = 1_001;
    await cache.release(await cache.acquire(url));
    now = 1_999;
    await cache.release(await cache.acquire(url));
    expect(fetcher).toHaveBeenCalledTimes(2);
    now = 2_002;
    await cache.release(await cache.acquire(url));
    expect(fetcher).toHaveBeenCalledTimes(3);
});

test('subtracts HTTP Age from the advertised cache lifetime', async () => {
    let now = 0;
    const fetcher = jest.fn(async () => response('section {}', {
        age: '59',
        'cache-control': 'max-age=60',
        'content-type': 'text/css',
    }));
    const cache = new RemoteThemeCache(async () => testRoot, { fetcher, now: () => now });
    const url = 'https://aged.example/theme.css';

    await cache.release(await cache.acquire(url));
    now = 999;
    await cache.release(await cache.acquire(url));
    expect(fetcher).toHaveBeenCalledTimes(1);
    now = 1_001;
    await cache.release(await cache.acquire(url));
    expect(fetcher).toHaveBeenCalledTimes(2);
});

test('deduplicates overlapping no-store leases for identical CSS without early removal', async () => {
    const fetcher: RemoteThemeFetcher = jest.fn(async () => response(
        'section { color: green }',
        { 'cache-control': 'no-store', 'content-type': 'text/css' },
    ));
    const cache = new RemoteThemeCache(async () => testRoot, { fetcher });
    const url = 'https://no-store.example/theme.css';

    const first = await cache.acquire(url);
    const second = await cache.acquire(url);
    expect(second.path).toBe(first.path);
    await cache.release(first);
    expect(await fs.stat(second.path)).toBeDefined();
    await cache.release(second);
    await expect(fs.stat(second.path)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('shares one in-flight request per URL and cancels when every consumer leaves', async () => {
    let finish!: (value: RemoteThemeHttpResponse) => void;
    let underlyingSignal: AbortSignal | undefined;
    const fetcher: RemoteThemeFetcher = jest.fn(async (_url, _headers, signal) => {
        underlyingSignal = signal;
        return new Promise(resolve => { finish = resolve; });
    });
    const cache = new RemoteThemeCache(async () => testRoot, { fetcher });
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = cache.acquire('https://same.example/theme.css', firstController.signal);
    const second = cache.acquire('https://same.example/theme.css', secondController.signal);
    expect(fetcher).toHaveBeenCalledTimes(1);
    firstController.abort();
    await expect(first).rejects.toThrow('cancelled');
    expect(underlyingSignal?.aborted).toBe(false);

    finish(response('section {}'));
    const secondTheme = await second;
    expect(secondTheme.path).toContain('themes');
    await cache.release(secondTheme);

    const lastController = new AbortController();
    const pending = cache.acquire('https://other.example/theme.css', lastController.signal);
    lastController.abort();
    await expect(pending).rejects.toThrow('cancelled');
    expect(underlyingSignal?.aborted).toBe(true);
});

test('isolates identical remote basenames, hosts, and query identities', async () => {
    const fetcher: RemoteThemeFetcher = jest.fn(async url => response(
        `section { --source: "${new URL(url).host}${new URL(url).search}" }`,
        { 'content-type': 'text/css' },
        200,
        url,
    ));
    const cache = new RemoteThemeCache(async () => testRoot, { fetcher });
    const urls = [
        'https://one.example/theme.css?v=1',
        'https://two.example/theme.css?v=1',
        'https://one.example/theme.css?v=2',
    ];

    const themes = await Promise.all(urls.map(url => cache.acquire(url)));
    expect(new Set(themes.map(theme => theme.path)).size).toBe(3);
    expect(new Set(themes.map(theme => theme.name)).size).toBe(3);
    expect(fetcher).toHaveBeenCalledTimes(3);
    await Promise.all(themes.map(theme => cache.release(theme)));
});

test.each([
    response('<!doctype html><html>error</html>', { 'content-type': 'text/html' }),
    response('section {', { 'content-type': 'text/css' }),
    response('section {}', { 'content-length': String(REMOTE_THEME_MAX_BYTES + 1), 'content-type': 'text/css' }),
    response('not css', { 'content-type': 'application/json' }),
])('rejects incompatible, invalid, or oversized responses without publishing them', async badResponse => {
    const cache = new RemoteThemeCache(async () => testRoot, {
        fetcher: async () => badResponse,
    });
    await expect(cache.acquire('https://bad.example/theme.css')).rejects.toThrow();
    await expect(fs.stat(join(testRoot, 'themes'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('rebases protocol-relative CSS resources and rejects local or executable schemes', () => {
    const prepared = prepareRemoteThemeCss(
        [
            '@import url("//cdn.example.com/base.css");',
            'section {',
            '  background: url(//cdn.example.com/a.png);',
            '  background-image: image-set("../images/one.png" 1x, "//cdn.example.com/two.png" 2x);',
            '}',
        ].join('\n'),
        'https://themes.example.com/path/theme.css',
        'remote-safe',
    );
    expect(prepared).toContain('https://cdn.example.com/base.css');
    expect(prepared).toContain('https://cdn.example.com/a.png');
    expect(prepared).toContain('https://themes.example.com/images/one.png');
    expect(prepared).toContain('https://cdn.example.com/two.png');

    for (const unsafe of [
        'section { background: url(file:///etc/passwd) }',
        'section { background: url(blob:https://example.com/id) }',
        '@import "javascript:alert(1)";',
        '@IMPORT "file:///tmp/local.css";',
        'section { background: u\\72l(file:///etc/passwd) }',
        'section { background-image: image-set("file:///tmp/local-secret.png" 1x) }',
        'section { background-image: i\\6d age-set("file:///tmp/local-secret.png" 1x) }',
        'section { background-image: -WEBKIT-IMAGE-SET("blob:https://example.com/id" 1x) }',
    ]) {
        expect(() => prepareRemoteThemeCss(
            unsafe,
            'https://themes.example.com/theme.css',
            'remote-unsafe',
        )).toThrow('is not allowed');
    }
});

test('preserves an escaped-quote data image-set as one inert string', () => {
    const payload = 'section{background-image:image-set("data:x\\");} .evil{background:url(file:///tmp/local-secret.png)} .dummy{content:foo(\\"x")}';
    const prepared = prepareRemoteThemeCss(
        payload,
        'https://themes.example.com/theme.css',
        'remote-inert',
    );
    const selectors: string[] = [];
    postcss.parse(prepared).walkRules(rule => {
        selectors.push(rule.selector);
    });

    expect(prepared).toContain(payload);
    expect(selectors).not.toContain('.evil');
});

test('strips a UTF-8 BOM and fails closed on refresh errors', async () => {
    let now = 0;
    const fetcher = jest.fn()
        .mockResolvedValueOnce(response('\uFEFFsection { color: red }'))
        .mockResolvedValueOnce(response('server error', {}, 503));
    const cache = new RemoteThemeCache(async () => testRoot, { fetcher, maxTtlMs: 1, now: () => now });
    const first = await cache.acquire('https://fail.example/theme.css');
    expect(first.css.startsWith('\uFEFF')).toBe(false);
    await cache.release(first);
    now = 2;
    await expect(cache.acquire('https://fail.example/theme.css')).rejects.toThrow('HTTP 503');
    expect(await fs.readFile(first.path, 'utf8')).toBe(first.css);
});

test('cleans partial files and surfaces an atomic publication failure', async () => {
    const rename = jest.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk rename failed'));
    const cache = new RemoteThemeCache(async () => testRoot, {
        fetcher: async () => response('section {}'),
    });

    await expect(cache.acquire('https://disk.example/theme.css'))
        .rejects.toThrow('Unable to publish the downloaded theme');
    const files = await fs.readdir(join(testRoot, 'themes'));
    expect(files).toEqual([]);
    rename.mockRestore();
});

test.each(['mkdir', 'writeFile', 'rename'] as const)(
    'dispose waits for an in-progress %s publication and prevents root recreation',
    async operation => {
        const started = deferred<void>();
        const proceed = deferred<void>();
        const base = remoteFileSystem();
        let fileSystem: RemoteThemeFileSystem;
        switch (operation) {
            case 'mkdir':
                fileSystem = remoteFileSystem({
                    mkdir: async (path, options) => {
                        started.resolve(undefined);
                        await proceed.promise;
                        return base.mkdir(path, options);
                    },
                });
                break;
            case 'writeFile':
                fileSystem = remoteFileSystem({
                    writeFile: async (path, data, encoding) => {
                        started.resolve(undefined);
                        await proceed.promise;
                        return base.writeFile(path, data, encoding);
                    },
                });
                break;
            case 'rename':
                fileSystem = remoteFileSystem({
                    rename: async (oldPath, newPath) => {
                        started.resolve(undefined);
                        await proceed.promise;
                        return base.rename(oldPath, newPath);
                    },
                });
                break;
        }
        const cache = new RemoteThemeCache(async () => testRoot, {
            fetcher: async () => response('section {}'),
            fileSystem,
        });

        const acquisition = cache.acquire(`https://dispose.example/${operation}.css`);
        const rejectedAcquisition = expect(acquisition).rejects.toThrow('cancelled');
        await started.promise;
        let disposeSettled = false;
        const disposal = cache.dispose().then(() => { disposeSettled = true; });
        await Promise.resolve();
        expect(disposeSettled).toBe(false);

        proceed.resolve(undefined);
        await disposal;
        await rejectedAcquisition;
        await fs.rm(testRoot, { recursive: true, force: true });
        await Promise.resolve();
        await expect(fs.stat(testRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    },
);

test('HTTP client follows bounded relative redirects and strips validators across origins', async () => {
    const requests: Array<{ headers: Readonly<Record<string, string>>; url: string }> = [];
    const requester: RemoteThemeRequester = async (url, headers) => {
        requests.push({ url: url.href, headers: { ...headers } });
        if (requests.length === 1) {
            return {
                status: 302,
                headers: { location: 'https://other.example/theme.css' } as Record<string, string>,
                body: Buffer.alloc(0),
            };
        }
        return {
            status: 200,
            headers: { 'content-type': 'text/css' } as Record<string, string>,
            body: Buffer.from('section {}'),
        };
    };

    const result = await fetchRemoteThemeWith(
        requester,
        'https://origin.example/start',
        { 'If-None-Match': '"private-to-origin"' },
        new AbortController().signal,
    );
    expect(result.status).toBe(200);
    expect(result.finalUrl).toBe('https://other.example/theme.css');
    expect(requests[0].headers).toEqual({ 'If-None-Match': '"private-to-origin"' });
    expect(requests[1].headers).toEqual({});
    expect(result.validatorsSent).toBe(false);
});

test('rejects a cross-origin final 304 after conditional validators were stripped', async () => {
    let now = 0;
    const requester: RemoteThemeRequester = async url => url.host === 'origin.example'
        ? {
            status: 302,
            headers: { location: 'https://other.example/theme.css' } as Record<string, string>,
            body: Buffer.alloc(0),
        }
        : { status: 304, headers: {} as Record<string, string>, body: Buffer.alloc(0) };
    const redirected304: RemoteThemeFetcher = (url, headers, signal) =>
        fetchRemoteThemeWith(requester, url, headers, signal);
    const fetcher = jest.fn()
        .mockResolvedValueOnce(response('section { color: red }', {
            'content-type': 'text/css',
            etag: '"v1"',
        }, 200, 'https://other.example/theme.css'))
        .mockImplementationOnce(redirected304);
    const cache = new RemoteThemeCache(async () => testRoot, {
        fetcher,
        maxTtlMs: 1,
        now: () => now,
    });
    const url = 'https://origin.example/theme.css';

    await cache.release(await cache.acquire(url));
    now = 2;
    await expect(cache.acquire(url)).rejects.toThrow(
        '304 without a validator on the final request',
    );
});

test('rejects redirect loops and HTTPS downgrade targets', async () => {
    const loop: RemoteThemeRequester = async () => ({
        status: 302,
        headers: { location: '/loop' },
        body: Buffer.alloc(0),
    });
    await expect(fetchRemoteThemeWith(
            loop,
            'https://loop.example/loop',
            {},
            new AbortController().signal,
        )).rejects.toThrow('redirect limit');
    expect(() => validateRemoteThemeRedirect(
        new URL('https://secure.example/theme.css'),
        new URL('http://secure.example/theme.css'),
    )).toThrow('downgrade');
});
