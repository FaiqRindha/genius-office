import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { GitLabSignIns, gitlabUrl, whoAmI, withGitLab, type GitLabWhoAmI } from '../src/server/gitlab.ts';
import type { RunAs } from '../src/server/workers/types.ts';

const ID = 'acct123456';
const TOKEN = 'glpat-abcdefghijklmnopqrst';

function office(ask: GitLabWhoAmI) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ao-gitlab-'));
  const changed: string[] = [];
  return { dir, changed, gitlab: new GitLabSignIns(dir, (id) => changed.push(id), ask) };
}

const takes: GitLabWhoAmI = async (_url, token) => (token === TOKEN ? { username: 'faiq' } : { error: 'nope', signedOut: true });

test('a GitLab address is made whole from however it was typed', () => {
  assert.equal(gitlabUrl('gitlab.example.com'), 'https://gitlab.example.com');
  assert.equal(gitlabUrl(' https://gitlab.example.com/ '), 'https://gitlab.example.com');
  assert.equal(gitlabUrl('http://10.0.0.5:8080/gitlab/'), 'http://10.0.0.5:8080/gitlab');
  assert.equal(gitlabUrl('https://user:pw@gitlab.example.com'), undefined);
  assert.equal(gitlabUrl('ftp://gitlab.example.com'), undefined);
  assert.equal(gitlabUrl('https://gitlab.example.com/?x=1'), undefined);
  assert.equal(gitlabUrl(''), undefined);
});

test('a token GitLab takes is kept, privately; one it turns down is not', async () => {
  const { dir, gitlab, changed } = office(takes);
  assert.equal(await gitlab.token(ID, 'gitlab.example.com', 'glpat-wrongwrongwrongwrong'), 'nope');
  assert.equal(existsSync(path.join(dir, 'homes', ID, 'gitlab.json')), false);
  assert.equal(gitlab.state(ID).status, 'none');

  assert.equal(await gitlab.token(ID, 'gitlab.example.com/', TOKEN), undefined);
  assert.deepEqual(gitlab.state(ID), { status: 'ok', url: 'https://gitlab.example.com', who: '@faiq' });
  const file = path.join(dir, 'homes', ID, 'gitlab.json');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).token, TOKEN);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(changed.every((id) => id === ID) && changed.length > 0);

  // A fresh start of the office knows it without asking GitLab first.
  const again = new GitLabSignIns(dir, () => {}, takes);
  assert.equal(again.state(ID).who, '@faiq');

  gitlab.signOut(ID);
  assert.equal(existsSync(file), false);
  assert.equal(gitlab.state(ID).status, 'none');
});

test('nonsense is turned down before GitLab is asked', async () => {
  let asked = 0;
  const { gitlab } = office(async () => (asked++, { username: 'x' }));
  assert.match((await gitlab.token(ID, 'not a url at all', TOKEN)) ?? '', /address/);
  assert.match((await gitlab.token(ID, 'gitlab.example.com', 'short')) ?? '', /token/);
  assert.equal(asked, 0);
});

test('a token GitLab stops taking shows as signed out', async () => {
  let ok = true;
  const { gitlab } = office(async () => (ok ? { username: 'faiq' } : { error: 'no', signedOut: true }));
  await gitlab.token(ID, 'gitlab.example.com', TOKEN);
  ok = false;
  await gitlab.look(ID, true);
  assert.equal(gitlab.state(ID).status, 'none');
  assert.match(gitlab.state(ID).error ?? '', /paste a new one/);
});

test("workers get their own GitLab, never the office's", async () => {
  const { dir, gitlab } = office(takes);
  const officeEnv = { PATH: process.env.PATH ?? '', GITLAB_TOKEN: 'office-token', GL_HOST: 'office.example', GLAB_CONFIG_DIR: '/office/glab' };

  const unsigned = gitlab.apply(ID, { ...officeEnv });
  assert.equal(unsigned.GITLAB_TOKEN, undefined);
  assert.equal(unsigned.GL_HOST, undefined);
  assert.equal(unsigned.GLAB_CONFIG_DIR, path.join(dir, 'homes', ID, 'glab'));

  await gitlab.token(ID, 'https://gitlab.example.com:8443/', TOKEN);
  const env = gitlab.apply(ID, { ...officeEnv, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.pager', GIT_CONFIG_VALUE_0: 'cat' });
  assert.equal(env.GITLAB_HOST, 'https://gitlab.example.com:8443');
  assert.equal(env.GITLAB_TOKEN, TOKEN);
  assert.equal(env.GIT_CONFIG_COUNT, '3');
  assert.equal(env.GIT_CONFIG_KEY_0, 'core.pager');

  // git itself answers with the token for that GitLab, and only for it.
  const fill = (host: string) =>
    execFileSync('git', ['credential', 'fill'], { input: `protocol=https\nhost=${host}\n\n`, env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
  assert.match(fill('gitlab.example.com:8443'), new RegExp(`username=oauth2\\npassword=${TOKEN}`));
  assert.throws(() => fill('github.com'));
});

test("withGitLab adds the GitLab to an account's other sign-ins", async () => {
  const { gitlab } = office(takes);
  await gitlab.token(ID, 'gitlab.example.com', TOKEN);
  const inner: RunAs = { claudeReady: () => true, why: () => 'why', apply: (_o, env) => Object.assign(env, { GH_CONFIG_DIR: '/gh' }) };
  const env = withGitLab(inner, gitlab).apply(ID, {}, []);
  assert.equal(env.GH_CONFIG_DIR, '/gh');
  assert.equal(env.GITLAB_TOKEN, TOKEN);
});

test("GitLab's API is asked who a token is", async () => {
  const server = createServer((req, res) => {
    const ok = req.url === '/gitlab/api/v4/user' && req.headers['private-token'] === TOKEN;
    res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' }).end(JSON.stringify(ok ? { username: 'faiq' } : { message: '401 Unauthorized' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/gitlab`;
  try {
    assert.deepEqual(await whoAmI(url, TOKEN), { username: 'faiq' });
    const no = await whoAmI(url, 'glpat-wrongwrongwrongwrong');
    assert.ok('signedOut' in no && no.signedOut);
  } finally {
    server.close();
  }
  const gone = await whoAmI(url, TOKEN);
  assert.ok('error' in gone && /Couldn't reach/.test(gone.error));
});
