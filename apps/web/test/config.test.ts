import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { type HostConfig, readHostConfig, STATIC_CONFIG } from '../src/app/config';

/** The config a page gets when /config.js left `config` on it. */
const read = (config: unknown): HostConfig => readHostConfig({ simulciConfig: config });

const SERVER = {
  mode: 'server',
  githubUrl: 'https://ghe.example.com',
  apiUrl: 'https://ghe.example.com/api/v3',
  appSlug: 'simulci',
  signIn: true,
};

describe("the host's mode", () => {
  it('is static on github.com from public/config.js, run as the browser runs it before the app', () => {
    const page: Record<string, unknown> = {};
    page.globalThis = page;
    runInNewContext(readFileSync(new URL('../public/config.js', import.meta.url), 'utf8'), page);
    expect(page.simulciConfig).toEqual({ mode: 'static', githubUrl: 'https://github.com' });
    expect(readHostConfig(page)).toEqual(STATIC_CONFIG);
    expect(STATIC_CONFIG).toEqual({
      mode: 'static',
      githubUrl: 'https://github.com',
      apiUrl: 'https://api.github.com',
      signIn: false,
    });
  });

  it('loads /config.js as a classic script in the head, before the theme and the app', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const head = html.slice(0, html.indexOf('</head>'));
    expect(head).toContain('<script src="/config.js"></script>');
    expect(html.indexOf('/config.js')).toBeLessThan(html.indexOf('/theme.js'));
    expect(html.indexOf('/config.js')).toBeLessThan(html.indexOf('type="module"'));
  });

  it('reads the image’s server shape as it is', () => {
    expect(read(SERVER)).toEqual(SERVER);
    const { appSlug: _, ...noSignIn } = { ...SERVER, signIn: false };
    expect(read(noSignIn)).toEqual(noSignIn);
  });

  it('derives the API from GitHub’s origin when the host leaves it out', () => {
    expect(read({ mode: 'static', githubUrl: 'https://github.com/' })).toEqual(STATIC_CONFIG);
    expect(read({ mode: 'server', githubUrl: 'https://ghe.example.com', signIn: false })).toEqual({
      mode: 'server',
      githubUrl: 'https://ghe.example.com',
      apiUrl: 'https://ghe.example.com/api/v3',
      signIn: false,
    });
    expect(read({ ...SERVER, apiUrl: 'https://ghe.example.com/api/v3/' }).apiUrl).toBe(
      'https://ghe.example.com/api/v3',
    );
  });

  it('takes plain http on loopback only, for a server under test', () => {
    const local = { ...SERVER, githubUrl: 'http://localhost:9000', apiUrl: 'http://127.0.0.1:9001/api' };
    expect(read(local)).toEqual(local);
    expect(read({ ...SERVER, githubUrl: 'http://ghe.example.com' })).toEqual(STATIC_CONFIG);
  });

  it('is static on github.com when the config is missing', () => {
    expect(readHostConfig({})).toEqual(STATIC_CONFIG);
    for (const config of [undefined, null, 'server', 1, [], {}, { githubUrl: 'https://github.com' }])
      expect(read(config)).toEqual(STATIC_CONFIG);
  });

  it('is static on github.com when any field is malformed', () => {
    const malformed: Record<string, unknown>[] = [
      { mode: 'hosted' },
      { githubUrl: undefined },
      { githubUrl: 'ghe.example.com' },
      { githubUrl: 'javascript:alert(1)' },
      { githubUrl: 'https://ghe.example.com/org' },
      { githubUrl: 'https://ghe.example.com/?x=1' },
      { githubUrl: 'https://user:secret@ghe.example.com' },
      { apiUrl: 42 },
      { apiUrl: 'ftp://ghe.example.com/api/v3' },
      { apiUrl: '/api/github' },
      { apiUrl: 'https://ghe.example.com/api/v3#x' },
      { appSlug: 'Not A Slug' },
      { appSlug: '' },
      { signIn: 'yes' },
      { signIn: true, appSlug: undefined },
      { signIn: true, mode: 'static' },
    ];
    for (const change of malformed)
      expect(read({ ...SERVER, ...change }), JSON.stringify(change)).toEqual(STATIC_CONFIG);
  });

  it('is static on github.com when reading the config throws', () => {
    const scope = {
      get simulciConfig(): never {
        throw new Error('SecurityError');
      },
    };
    expect(readHostConfig(scope)).toEqual(STATIC_CONFIG);
  });
});
