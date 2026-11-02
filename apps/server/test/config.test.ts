import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';

/** The variables of § 6.7 that static mode reads, and the App's, which it refuses until sign-in exists. */

const problem = (env: Record<string, string>): string => {
  try {
    loadConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  throw new Error('the config loaded');
};

describe('the configuration', () => {
  it('serves github.com on port 8080 with nothing set, and tells the page so', () => {
    expect(loadConfig({})).toEqual({
      port: 8080,
      mode: { serve: 'static', github: 'github.com', host: 'image', https: false },
      page: { mode: 'static', githubUrl: 'https://github.com' },
    });
  });

  it('reads a GHES origin, an API override without its trailing slash, a port and an https public URL', () => {
    const config = loadConfig({
      PORT: '3000',
      PUBLIC_URL: 'https://simulci.example/',
      GITHUB_URL: 'https://ghes.example/',
      GITHUB_API_URL: 'https://ghes.example/api/v3/',
    });
    expect(config.port).toBe(3000);
    expect(config.mode).toEqual({ serve: 'static', github: 'ghes', host: 'image', https: true });
    expect(config.page).toEqual({
      mode: 'static',
      githubUrl: 'https://ghes.example',
      apiUrl: 'https://ghes.example/api/v3',
    });
  });

  it('takes plain http on this machine only, and an empty variable as unset', () => {
    expect(loadConfig({ GITHUB_URL: 'http://localhost:9000' }).page.githubUrl).toBe('http://localhost:9000');
    expect(loadConfig({ PUBLIC_URL: 'http://127.0.0.1:8080' }).mode.https).toBe(false);
    expect(loadConfig({ PORT: '', GITHUB_URL: '', GITHUB_APP_SLUG: '' }).port).toBe(8080);
    expect(problem({ GITHUB_URL: 'http://ghes.example' })).toBe(
      'GITHUB_URL must be https (plain http only on localhost)',
    );
  });

  it('names the variable of every bad value', () => {
    for (const port of ['eighty', '70000', '0', '80.5'])
      expect(problem({ PORT: port })).toBe('PORT must be a port number, 1 to 65535');
    expect(problem({ GITHUB_URL: 'ghes.example' })).toBe('GITHUB_URL is not an absolute URL');
    expect(problem({ GITHUB_URL: 'https://ghes.example/github' })).toBe(
      'GITHUB_URL must be an origin, with no path',
    );
    expect(problem({ GITHUB_API_URL: 'https://token@ghes.example/api/v3' })).toBe(
      'GITHUB_API_URL must have no credentials, query or fragment',
    );
    expect(problem({ PORT: '0', PUBLIC_URL: 'nope' }).split('\n')).toHaveLength(2);
  });

  it('refuses the GitHub App variables rather than serve without the sign-in they ask for', () => {
    for (const name of ['GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_SECRET', 'GITHUB_APP_SLUG'])
      expect(problem({ [name]: 'x' })).toBe(
        `${name} sign-in with a GitHub App is not in this version: unset it to serve the app alone`,
      );
  });
});
