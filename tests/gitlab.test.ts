import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

test('a GitLab project path is tidied, and never a way out of the projects folder', async () => {
  const { gitlabPath } = await import('../src/server/gitlab-projects.ts');
  assert.equal(gitlabPath('group/sub/project.git'), 'group/sub/project');
  assert.equal(gitlabPath('/group/project/'), 'group/project');
  assert.equal(gitlabPath('project'), undefined);
  assert.equal(gitlabPath('group/../etc'), undefined);
  assert.equal(gitlabPath('group/..'), undefined);
  assert.equal(gitlabPath('group/-x'), undefined);
  assert.equal(gitlabPath('group/a b'), undefined);
});

test('GitLab projects are listed and found with the account’s token', async () => {
  const { listProjects, findProject } = await import('../src/server/gitlab-projects.ts');
  const server = createServer((req, res) => {
    if (req.headers['private-token'] !== TOKEN) return res.writeHead(401).end('{}');
    const u = new URL(req.url!, 'http://x');
    if (u.pathname === '/api/v4/projects') {
      const page = Number(u.searchParams.get('page'));
      const items = page === 1 ? Array.from({ length: 100 }, (_, i) => ({ path_with_namespace: `grp/p${i}`, name: `P${i}`, last_activity_at: '2026-10-01T00:00:00Z' })) : [{ path_with_namespace: 'grp/sub/last', name: 'Last', description: 'the end' }];
      return res.writeHead(200, page === 1 ? { 'x-next-page': '2' } : {}).end(JSON.stringify(items));
    }
    if (u.pathname === `/api/v4/projects/${encodeURIComponent('grp/sub/last')}`) return res.writeHead(200).end(JSON.stringify({ path_with_namespace: 'Grp/Sub/Last', name: 'Last', empty_repo: false }));
    res.writeHead(404).end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const list = await listProjects(base, TOKEN);
    assert.equal(list.length, 101);
    assert.deepEqual(list[100], { path: 'grp/sub/last', name: 'Last', description: 'the end', pushedAt: undefined });
    await assert.rejects(listProjects(base, 'glpat-wrongwrongwrongwrong'), /stopped taking your token/);
    const found = await findProject(base, TOKEN, 'grp/sub/last');
    assert.deepEqual(found, { url: `${base}/Grp/Sub/Last`, cloneUrl: `${base}/Grp/Sub/Last.git`, path: 'Grp/Sub/Last', name: 'Last', host: new URL(base).host, empty: false });
    assert.match((await findProject(base, TOKEN, 'grp/nope')) as string, /no project there/);
  } finally {
    server.close();
  }
});

test('a GitLab project becomes a floor, cloned with git and its adder’s credentials', async (t) => {
  const { Building } = await import('../src/server/building.ts');
  const root = mkdtempSync(path.join(os.tmpdir(), 'ao-gitlab-floor-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // grp/sub/app "on GitLab": a bare repository the clone's own git config sends gitlab.example.com to.
  const work = path.join(root, 'work');
  execFileSync('git', ['init', '-q', work]);
  writeFileSync(path.join(work, 'README.md'), '# app');
  execFileSync('git', ['-C', work, 'add', '.']);
  execFileSync('git', ['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'first']);
  const remotes = path.join(root, 'remotes');
  execFileSync('git', ['clone', '-q', '--bare', work, path.join(remotes, 'grp', 'sub', 'app.git')]);
  const env = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${remotes}/.insteadOf`, GIT_CONFIG_VALUE_0: 'https://gitlab.example.com/' } as Record<string, string>;
  const dataDir = path.join(root, '.agent-office');
  mkdirSync(dataDir);
  const building = new Building(dataDir, path.join(root, 'projects'), { clone: { tickMs: 50, stallMs: 5000 } });
  const src = { url: 'https://gitlab.example.com/grp/sub/app', cloneUrl: 'https://gitlab.example.com/grp/sub/app.git', path: 'grp/sub/app', name: 'app', host: 'gitlab.example.com', empty: false };
  let started = 0;
  const def = await building.addGitLab(src, env, 'faiq', () => started++, ID);
  assert.equal(typeof def, 'object', String(def));
  const floor = def as Exclude<typeof def, string>;
  assert.equal(started, 1);
  assert.equal(floor.gitlab, src.url);
  assert.equal(floor.repo, undefined);
  assert.equal(floor.dir, path.join(root, 'projects', 'gitlab.example.com', 'grp', 'sub', 'app'));
  assert.ok(existsSync(path.join(floor.dir, 'README.md')));
  assert.match(await building.addGitLab(src, env, 'faiq', () => {}, ID) as string, /already has a floor/);
  // A fresh start of the office still knows it's that GitLab project.
  const again = new Building(dataDir, path.join(root, 'projects'));
  assert.equal(again.list()[0].gitlab, src.url);
  // A folder in the way that's some other checkout isn't taken for it.
  const other = { ...src, url: 'https://gitlab.example.com/grp/other', cloneUrl: 'https://gitlab.example.com/grp/other.git', path: 'grp/other', name: 'other' };
  mkdirSync(path.join(root, 'projects', 'gitlab.example.com', 'grp', 'other'), { recursive: true });
  execFileSync('git', ['init', '-q', path.join(root, 'projects', 'gitlab.example.com', 'grp', 'other')]);
  assert.match(await building.addGitLab(other, env, 'faiq', () => {}, ID) as string, /isn't a checkout of/);
});

test('git clones of a GitLab say what to do when it turns them down', async () => {
  const { whyGitLabCloneFailed } = await import('../src/server/gitlab-projects.ts');
  assert.match(whyGitLabCloneFailed("Cloning into 'x'...\nremote: HTTP Basic: Access denied\nfatal: Authentication failed for 'https://g.example/x.git/'", 'g.example'), /read_repository/);
  assert.match(whyGitLabCloneFailed('fatal: unable to access: SSL certificate problem: self-signed certificate', 'g.example'), /certificate/);
});
