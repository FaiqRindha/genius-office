import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GitLabBoards, type GitLabApi, type GitLabCreds } from '../src/server/gitlab-boards.ts';
import { GitLabSignIns } from '../src/server/gitlab.ts';
import type { GhIssue, GhState } from '../src/shared/protocol.ts';

const BASE = 'https://gitlab.example.com';
const PROJECT = `${BASE}/grp/sub/app`;
const READER: GitLabCreds = { url: BASE, token: 'glpat-reader' };
const ME = { key: 'gitlab:me', env: { GITLAB_HOST: BASE, GITLAB_TOKEN: 'glpat-mine' } };
const ID = encodeURIComponent('grp/sub/app');

interface Call {
  token: string;
  method: string;
  rest: string;
  body?: any;
}

/** A GitLab that answers from `routes` ("METHOD rest-prefix"), and remembers who asked what. */
function fakeGitLab(routes: Record<string, (body: any, rest: string) => any>) {
  const calls: Call[] = [];
  const api: GitLabApi = async (c, method, rest, body) => {
    calls.push({ token: c.token, method, rest, body });
    const key = Object.keys(routes).find((k) => `${method} ${rest}`.startsWith(k));
    if (!key) throw new Error(`no route for ${method} ${rest}`);
    return routes[key](body, rest);
  };
  return { api, calls };
}

const issue = (iid: number, state: 'opened' | 'closed', extra: object = {}) => ({
  iid,
  title: `Issue ${iid}`,
  state,
  web_url: `${PROJECT}/-/issues/${iid}`,
  author: { username: 'ana' },
  labels: [{ name: 'bug', color: '#d9534f', description: 'Broken' }],
  assignees: [],
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-02T00:00:00Z',
  description: 'It breaks',
  user_notes_count: 2,
  ...extra,
});

function boards(api: GitLabApi, reader: () => GitLabCreds | undefined = () => READER) {
  const seen: GhState<GhIssue>[] = [];
  const b = new GitLabBoards(PROJECT, reader, (s) => seen.push(s), () => {}, api);
  return { b, seen };
}

test("a GitLab project's issues fill the board the way GitHub's do", async () => {
  const { api, calls } = fakeGitLab({
    [`GET projects/${ID}/issues?state=opened`]: () => [issue(3, 'opened', { assignees: [{ username: 'bo' }] })],
    [`GET projects/${ID}/issues?state=closed`]: () => [issue(1, 'closed')],
  });
  const { b } = boards(api);
  await b.refresh();
  assert.equal(b.issues.error, undefined);
  assert.deepEqual(
    b.issues.items.map((i) => [i.number, i.state, i.assignees, i.labels[0].color, i.comments, i.url]),
    [
      [3, 'OPEN', ['bo'], '#d9534f', 2, `${PROJECT}/-/issues/3`],
      [1, 'CLOSED', [], '#d9534f', 2, `${PROJECT}/-/issues/1`],
    ],
  );
  // Read with the reader's token, from the project by its path.
  assert.ok(calls.every((c) => c.token === READER.token && c.rest.startsWith(`projects/${ID}/`)));
  // Merge requests come later: an empty board, not an error.
  assert.deepEqual([b.pulls.items, b.pulls.error], [[], undefined]);
});

test('with nobody signed in to that GitLab, the board says why', async () => {
  const { api } = fakeGitLab({});
  const { b } = boards(api, () => undefined);
  await b.refresh();
  assert.match(b.issues.error ?? '', /Nobody signed in to gitlab\.example\.com/);
});

test("an issue's window shows people's comments, not GitLab's own notes", async () => {
  const { api } = fakeGitLab({
    [`GET projects/${ID}/issues/3/notes`]: () => [
      { id: 10, system: true, body: 'added ~bug label', author: { username: 'ana' } },
      { id: 11, system: false, body: 'On it', author: { username: 'bo' }, created_at: '2026-10-03T00:00:00Z' },
    ],
    [`GET projects/${ID}/issues/3`]: () => issue(3, 'opened'),
  });
  const { b } = boards(api);
  const d = await b.issueDetail(3, 'faiq');
  assert.equal(d.state, 'OPEN');
  assert.equal(d.viewer, 'faiq');
  assert.deepEqual(d.comments, [{ id: '11', author: 'bo', body: 'On it', createdAt: '2026-10-03T00:00:00Z', url: `${PROJECT}/-/issues/3#note_11` }]);
});

test('comments, closing, labels and claims go out as whoever asked', async () => {
  const { api, calls } = fakeGitLab({
    [`POST projects/${ID}/issues/3/notes`]: (body) => ({ id: 12, body: body.body, author: { username: 'faiq' }, created_at: 'now' }),
    [`PUT projects/${ID}/issues/3`]: (body) => ({ ...issue(3, body.state_event === 'close' ? 'closed' : 'opened'), labels: ['bug', 'doing'] }),
    [`GET projects/${ID}/labels`]: () => [
      { name: 'bug', color: '#d9534f' },
      { name: 'doing', color: '#428bca' },
    ],
    [`GET projects/${ID}/issues`]: () => [],
    'GET user': () => ({ id: 77, username: 'faiq' }),
  });
  const { b } = boards(api);

  const c = await b.comment('issue', 3, 'Looking', ME);
  assert.equal(c.comment?.author, 'faiq');
  assert.deepEqual(calls.find((x) => x.method === 'POST'), { token: 'glpat-mine', method: 'POST', rest: `projects/${ID}/issues/3/notes`, body: { body: 'Looking' } });

  const l = await b.setLabels('issue', 3, ['doing'], ['wontfix'], ME);
  assert.deepEqual(l.labels, [
    { name: 'bug', color: '#d9534f' },
    { name: 'doing', color: '#428bca' },
  ]);
  assert.deepEqual(calls.find((x) => x.method === 'PUT')?.body, { add_labels: 'doing', remove_labels: 'wontfix' });
  assert.match((await b.setLabels('issue', 3, ['a,b'], [], ME)).error ?? '', /comma/);

  calls.length = 0;
  assert.equal(await b.claim(3, ME), undefined);
  assert.deepEqual(
    calls.filter((x) => x.method !== 'GET' || x.rest === 'user').map((x) => [x.token, x.method, x.rest, x.body]),
    [
      ['glpat-mine', 'GET', 'user', undefined],
      ['glpat-mine', 'PUT', `projects/${ID}/issues/3`, { assignee_ids: [77] }],
    ],
  );

  calls.length = 0;
  assert.equal(await b.close('issue', 3, { comment: 'Done', reason: 'not planned' }, ME), undefined);
  assert.deepEqual(
    calls.filter((x) => x.method !== 'GET').map((x) => [x.method, x.rest, x.body]),
    [
      ['POST', `projects/${ID}/issues/3/notes`, { body: 'Done' }],
      ['PUT', `projects/${ID}/issues/3`, { state_event: 'close' }],
    ],
  );
});

test("someone signed in to another GitLab can't act on this one", async () => {
  const { api } = fakeGitLab({});
  const { b } = boards(api);
  const r = await b.comment('issue', 3, 'hi', { key: 'x', env: { GITLAB_HOST: 'https://other.example', GITLAB_TOKEN: 't' } });
  assert.match(r.error ?? '', /for other\.example, not gitlab\.example\.com/);
});

test('merge requests say they come later, instead of failing oddly', async () => {
  const { api } = fakeGitLab({});
  const { b } = boards(api);
  assert.match((await b.merge(1, 'merge', false, false, ME)) ?? '', /merge requests/);
  await assert.rejects(b.pullDetail(1), /merge requests/);
  assert.match((await b.comment('pull', 1, 'x', ME)).error ?? '', /merge requests/);
});

test("a GitLab floor's boards are read by whoever added it, else anyone on that GitLab", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ao-gitlab-reader-'));
  const signins = new GitLabSignIns(dir, () => {}, async () => ({ username: 'u' }));
  await signins.token('aaaaaa1', 'https://other.example', 'glpat-otherotherother1');
  await signins.token('bbbbbb2', 'gitlab.example.com', 'glpat-bbbbbbbbbbbbbbb2');
  await signins.token('cccccc3', 'gitlab.example.com', 'glpat-ccccccccccccccc3');
  assert.equal(signins.reader(PROJECT, 'cccccc3')?.token, 'glpat-ccccccccccccccc3');
  // The adder signed out: the first other account on that GitLab.
  signins.signOut('cccccc3');
  assert.equal(signins.reader(PROJECT, 'cccccc3')?.token, 'glpat-bbbbbbbbbbbbbbb2');
  assert.equal(signins.reader('https://nowhere.example/g/p'), undefined);
  assert.deepEqual(signins.ghAs('bbbbbb2'), { key: 'gitlab:bbbbbb2', env: { GITLAB_HOST: 'https://gitlab.example.com', GITLAB_TOKEN: 'glpat-bbbbbbbbbbbbbbb2' } });
  assert.match(signins.ghAs('cccccc3') as string, /Sign in to GitLab first/);
});
