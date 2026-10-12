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
    [`GET projects/${ID}/merge_requests`]: () => [],
    [`GET projects/${ID}/pipelines`]: () => [],
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

const mr = (iid: number, state: string, extra: object = {}) => ({
  iid,
  title: `MR ${iid}`,
  state,
  draft: false,
  web_url: `${PROJECT}/-/merge_requests/${iid}`,
  author: { username: 'bo' },
  labels: [{ name: 'feature', color: '#428bca' }],
  source_branch: `feat-${iid}`,
  target_branch: 'main',
  sha: `sha${iid}`,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-02T00:00:00Z',
  description: `Closes #4 and fixes #5, #6`,
  ...extra,
});

test("a GitLab project's merge requests fill the PR board, with their pipelines", async () => {
  const { api, calls } = fakeGitLab({
    [`GET projects/${ID}/merge_requests?state=opened`]: () => [mr(9, 'opened', { draft: true, detailed_merge_status: 'not_approved' })],
    [`GET projects/${ID}/merge_requests?state=merged`]: () => [mr(8, 'merged')],
    [`GET projects/${ID}/merge_requests?state=closed`]: () => [mr(7, 'closed')],
    [`GET projects/${ID}/pipelines`]: () => [
      { sha: 'sha9', status: 'running' },
      { sha: 'sha8', status: 'success' },
      { sha: 'sha8', status: 'failed' },
    ],
    [`GET projects/${ID}/issues`]: () => [],
  });
  const { b } = boards(api);
  await b.refresh();
  assert.equal(b.pulls.error, undefined);
  assert.deepEqual(
    b.pulls.items.map((p) => [p.number, p.state, p.isDraft, p.checks, p.headRefName, p.baseRefName, p.reviewDecision, p.closes]),
    [
      [9, 'OPEN', true, 'pending', 'feat-9', 'main', 'REVIEW_REQUIRED', [4, 5, 6]],
      // Its latest pipeline (GitLab lists the newest first).
      [8, 'MERGED', false, 'pass', 'feat-8', 'main', '', [4, 5, 6]],
      [7, 'CLOSED', false, 'none', 'feat-7', 'main', '', [4, 5, 6]],
    ],
  );
  assert.ok(calls.every((c) => c.token === READER.token));
});

test("an MR's window: whether it can merge, its approvals, line comments and pipeline jobs", async () => {
  const { api } = fakeGitLab({
    [`GET projects/${ID}/merge_requests/9/notes`]: () => [
      { id: 1, system: true, body: 'added 1 commit' },
      { id: 2, body: 'Looks good', author: { username: 'ana' }, created_at: 't1' },
      { id: 3, type: 'DiffNote', body: 'Typo', author: { username: 'ana' }, created_at: 't2', position: { new_path: 'a.ts', old_path: 'a.ts', new_line: 12, old_line: null } },
      { id: 4, type: 'DiffNote', body: 'Why gone?', author: { username: 'ana' }, created_at: 't3', position: { new_path: 'b.ts', old_path: 'b.ts', new_line: null, old_line: 3 } },
    ],
    [`GET projects/${ID}/merge_requests/9/commits`]: () => [{}, {}],
    [`GET projects/${ID}/merge_requests/9/approvals`]: () => ({ approved_by: [{ user: { id: 5, username: 'ana' } }], updated_at: 't4' }),
    [`GET projects/${ID}/merge_requests/9`]: () => mr(9, 'opened', { detailed_merge_status: 'ci_must_pass', has_conflicts: false, head_pipeline: { id: 33, status: 'running', web_url: 'p' } }),
    [`GET projects/${ID}/pipelines/33/jobs`]: () => [
      { id: 1, stage: 'test', name: 'unit', status: 'failed', web_url: 'j1' },
      { id: 2, stage: 'test', name: 'unit', status: 'running', web_url: 'j2' },
      { id: 3, stage: 'build', name: 'image', status: 'success', web_url: 'j3' },
    ],
    [`GET projects/${encodeURIComponent('grp/sub/app')}`]: () => ({ path_with_namespace: 'grp/sub/app', squash_option: 'default_off' }),
  });
  const { b } = boards(api);
  const d = await b.pullDetail(9, 'faiq');
  assert.deepEqual([d.state, d.mergeable, d.mergeStateStatus, d.reviewDecision, d.commits, d.viewer], ['OPEN', 'MERGEABLE', 'BLOCKED', 'APPROVED', 2, 'faiq']);
  assert.deepEqual(d.repo, { nameWithOwner: 'grp/sub/app', methods: ['merge', 'squash'] });
  assert.deepEqual(d.comments.map((c) => c.body), ['Looks good']);
  assert.deepEqual(d.reviews.map((r) => [r.author, r.state]), [['ana', 'APPROVED']]);
  assert.deepEqual(d.reviewComments.map((c) => [c.path, c.line, c.side, c.url]), [
    ['a.ts', 12, 'RIGHT', `${PROJECT}/-/merge_requests/9#note_3`],
    ['b.ts', 3, 'LEFT', `${PROJECT}/-/merge_requests/9#note_4`],
  ]);
  // A retried job counts as its last run.
  assert.deepEqual(d.checks, [
    { name: 'test / unit', state: 'pending', url: 'j2' },
    { name: 'build / image', state: 'pass', url: 'j3' },
  ]);
});

test('merging, closing and labeling an MR go out as whoever asked', async () => {
  const { api, calls } = fakeGitLab({
    [`PUT projects/${ID}/merge_requests/9/merge`]: () => ({}),
    [`PUT projects/${ID}/merge_requests/9`]: (body) => (body.state_event ? { ...mr(9, 'closed') } : { ...mr(9, 'opened'), labels: ['feature', 'ready'] }),
    [`DELETE projects/${ID}/repository/branches/feat-9`]: () => undefined,
    [`POST projects/${ID}/merge_requests/9/notes`]: (body) => ({ id: 50, body: body.body, author: { username: 'faiq' } }),
    [`GET projects/${ID}/labels`]: () => [{ name: 'ready', color: '#5cb85c' }],
    [`GET projects/${ID}/`]: () => [],
  });
  const { b } = boards(api);
  assert.equal(await b.merge(9, 'squash', true, true, ME), undefined);
  assert.equal(await b.close('pull', 9, { comment: 'Superseded', deleteBranch: true }, ME), undefined);
  assert.deepEqual((await b.setLabels('pull', 9, ['ready'], [], ME)).labels?.map((l) => [l.name, l.color]), [
    ['feature', '#888888'],
    ['ready', '#5cb85c'],
  ]);
  assert.equal((await b.comment('pull', 9, 'Nice', ME)).comment?.author, 'faiq');
  assert.deepEqual(
    calls.filter((c) => c.method !== 'GET').map((c) => [c.token, c.method, c.rest, c.body]),
    [
      ['glpat-mine', 'PUT', `projects/${ID}/merge_requests/9/merge`, { squash: true, should_remove_source_branch: true, merge_when_pipeline_succeeds: true }],
      ['glpat-mine', 'POST', `projects/${ID}/merge_requests/9/notes`, { body: 'Superseded' }],
      ['glpat-mine', 'PUT', `projects/${ID}/merge_requests/9`, { state_event: 'close' }],
      ['glpat-mine', 'DELETE', `projects/${ID}/repository/branches/feat-9`, undefined],
      ['glpat-mine', 'PUT', `projects/${ID}/merge_requests/9`, { add_labels: 'ready', remove_labels: '' }],
      ['glpat-mine', 'POST', `projects/${ID}/merge_requests/9/notes`, { body: 'Nice' }],
    ],
  );
});

test("an MR's changes come out as one unified diff", async () => {
  const { api } = fakeGitLab({
    [`GET projects/${ID}/merge_requests/9/diffs`]: () => [
      { old_path: 'a.ts', new_path: 'a.ts', diff: '@@ -1 +1 @@\n-old\n+new\n' },
      { old_path: 'n.ts', new_path: 'n.ts', new_file: true, diff: '@@ -0,0 +1 @@\n+hi\n' },
    ],
  });
  const { b } = boards(api);
  assert.equal(
    await b.pullDiff(9),
    ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1 +1 @@', '-old', '+new', 'diff --git a/n.ts b/n.ts', 'new file mode 100644', '--- /dev/null', '+++ b/n.ts', '@@ -0,0 +1 @@', '+hi'].join('\n'),
  );
});

test('GitLab says whether an MR can merge, in the words the merge window knows', async () => {
  const { mergeability, closesOf } = await import('../src/server/gitlab-mrs.ts');
  assert.deepEqual(mergeability({ detailed_merge_status: 'mergeable' }), { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' });
  assert.deepEqual(mergeability({ detailed_merge_status: 'conflict', has_conflicts: true }), { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
  assert.deepEqual(mergeability({ detailed_merge_status: 'need_rebase' }), { mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND' });
  assert.deepEqual(mergeability({ detailed_merge_status: 'checking' }), { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' });
  assert.deepEqual(mergeability({ detailed_merge_status: 'discussions_not_resolved' }), { mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' });
  // An older GitLab, with only merge_status.
  assert.deepEqual(mergeability({ merge_status: 'can_be_merged' }), { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' });
  assert.deepEqual(closesOf('Fixes #12. Also resolves #3 and #4; mentions #9'), [12, 3, 4]);
  assert.deepEqual(closesOf('closing: #7'), [7]);
});

test('an open MR someone approved goes in the Approved column', async () => {
  const { api } = fakeGitLab({
    [`GET projects/${ID}/merge_requests/12/approvals`]: () => ({ approved_by: [{ user: { id: 3, username: 'rina' } }] }),
    [`GET projects/${ID}/merge_requests/13/approvals`]: () => ({ approved_by: [] }),
    [`GET projects/${ID}/merge_requests?state=opened`]: () => [mr(12, 'opened'), mr(13, 'opened')],
    [`GET projects/${ID}/merge_requests`]: () => [],
    [`GET projects/${ID}/pipelines`]: () => [],
    [`GET projects/${ID}/issues`]: () => [],
  });
  const { b } = boards(api);
  await b.refresh();
  assert.deepEqual(b.pulls.items.map((p) => [p.number, p.reviewDecision]), [
    [12, 'APPROVED'],
    [13, ''],
  ]);
});
