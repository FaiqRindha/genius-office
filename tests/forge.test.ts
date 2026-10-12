import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMr, editMrBody, gitlabEnv, gitlabFloorAt, openMr, pushEnv, setGitLabFloor, type GitLabFloor } from '../src/server/forge.ts';
import type { GitLabApi } from '../src/server/gitlab-boards.ts';
import { readPrRequest } from '../src/server/office-workers.ts';
import { ownPr, relatedBlock } from '../src/server/workers/pr.ts';

const PROJECT = 'https://gitlab.example.com/grp/sub/app';
const ID = encodeURIComponent('grp/sub/app');
const READER = { url: 'https://gitlab.example.com', token: 'glpat-reader' };
const floor: GitLabFloor = { project: PROJECT, reader: () => READER };

function fake(answer: (method: string, rest: string, body: any) => any) {
  const calls: { token: string; method: string; rest: string; body?: any }[] = [];
  const api: GitLabApi = async (c, method, rest, body) => {
    calls.push({ token: c.token, method, rest, body });
    return answer(method, rest, body);
  };
  return { api, calls };
}

test("a GitLab floor is known by its checkout's folder, and by the worktrees in it", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ao-forge-'));
  const dir = path.join(root, 'app');
  const wt = path.join(dir, '.agent-office', 'worktrees', 'ada');
  mkdirSync(wt, { recursive: true });
  setGitLabFloor(dir, floor);
  assert.equal(gitlabFloorAt(dir), floor);
  assert.equal(gitlabFloorAt(wt), floor);
  assert.equal(gitlabFloorAt(root), undefined);
  assert.equal(gitlabFloorAt(`${dir}-other`), undefined);
  setGitLabFloor(dir, undefined);
  assert.equal(gitlabFloorAt(wt), undefined);
});

test('a merge request is found and opened for a branch, as whoever asked', async () => {
  const mine = gitlabEnv({ PATH: process.env.PATH }, { url: 'https://gitlab.example.com', token: 'glpat-mine' });
  const { api, calls } = fake((method, rest) => {
    if (rest.includes('merge_requests?state=opened')) return [];
    if (method === 'GET' && rest === `projects/${ID}`) return { default_branch: 'develop' };
    if (method === 'POST') return { iid: 15, web_url: `${PROJECT}/-/merge_requests/15` };
    if (method === 'GET') return { description: 'Body' };
    return {};
  });
  assert.equal(await openMr(floor, 'agent/ada', mine, api), undefined);
  assert.deepEqual(await createMr(floor, 'agent/ada', undefined, 'Fix it', 'Closes #4', mine, api), { number: 15, url: `${PROJECT}/-/merge_requests/15` });
  await editMrBody(floor, 15, (b) => `${b}\n\nmore`, undefined, api);
  assert.deepEqual(
    calls.map((c) => [c.token, c.method, c.rest, c.body]),
    [
      ['glpat-mine', 'GET', `projects/${ID}/merge_requests?state=opened&source_branch=agent%2Fada&per_page=1`, undefined],
      // No base given: the project's default branch.
      ['glpat-mine', 'GET', `projects/${ID}`, undefined],
      ['glpat-mine', 'POST', `projects/${ID}/merge_requests`, { source_branch: 'agent/ada', target_branch: 'develop', title: 'Fix it', description: 'Closes #4', remove_source_branch: true }],
      // With nobody's own token, the reader's.
      ['glpat-reader', 'GET', `projects/${ID}/merge_requests/15`, undefined],
      ['glpat-reader', 'PUT', `projects/${ID}/merge_requests/15`, { description: 'Body\n\nmore' }],
    ],
  );
});

test('with nobody signed in to that GitLab, opening a merge request says why', async () => {
  const { api } = fake(() => []);
  await assert.rejects(openMr({ project: PROJECT, reader: () => undefined }, 'b', undefined, api), /Nobody signed in to gitlab\.example\.com/);
});

test("pushes to a GitLab floor go out with someone's own token, else the reader's, and git takes it", () => {
  const mine = gitlabEnv({ PATH: process.env.PATH }, { url: 'https://gitlab.example.com', token: 'glpat-mine' });
  assert.equal(pushEnv(floor, mine), mine);
  const office = pushEnv(floor, undefined)!;
  assert.equal(office.GITLAB_TOKEN, 'glpat-reader');
  const fill = (env: Record<string, string>) =>
    execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=gitlab.example.com\n\n', env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }, encoding: 'utf8' });
  assert.match(fill(mine), /password=glpat-mine/);
  assert.match(fill(office), /password=glpat-reader/);
});

test("a worker's own `glab mr create` is its merge request, and board agents can name one", () => {
  const url = `${PROJECT}/-/merge_requests/12`;
  assert.deepEqual(ownPr('glab mr create --fill --yes', `Creating merge request for agent/ada into main\n${url}\n`), { repo: 'grp/sub/app', number: 12, url });
  assert.equal(ownPr('glab mr list', url), undefined);
  assert.deepEqual(readPrRequest({ pr: url }), { pr: 12, repo: 'grp/sub/app' });
  assert.deepEqual(readPrRequest({ pr: '!12' }), { pr: 12 });
  // A change across repositories lists GitLab's the way GitLab links them.
  assert.match(relatedBlock([{ repo: 'app', url }], url, 'agent/ada'), /grp\/sub\/app!12 \(this one\)/);
});
