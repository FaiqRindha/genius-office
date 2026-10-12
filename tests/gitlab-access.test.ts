import test from 'node:test';
import assert from 'node:assert/strict';
import { GitLabAccess, ROLE, roleName } from '../src/server/gitlab-access.ts';
import type { GitLabApi } from '../src/server/gitlab-boards.ts';

/** A GitLab where `ana` is a Developer on 1 (through its group), a Reporter on 2, and nothing on 3. */
function gitlab() {
  const asked: string[] = [];
  const api: GitLabApi = async (c, _m, rest) => {
    asked.push(`${c.token} ${rest}`);
    if (c.token !== 'ana') return [];
    if (!rest.includes('id_after=0')) return [];
    return [
      { id: 1, permissions: { project_access: null, group_access: { access_level: 30 } } },
      { id: 2, permissions: { project_access: { access_level: 20 }, group_access: { access_level: 10 } } },
    ];
  };
  return { api, asked };
}

test("someone's role in each project is their own GitLab membership, the higher of project and group", async () => {
  const { api, asked } = gitlab();
  const changed: string[] = [];
  const access = new GitLabAccess((a) => (a === 'acct01' ? { url: 'https://gl.example', token: 'ana' } : undefined), (a) => changed.push(a), api);
  // Never looked yet: unknown (and it goes and looks).
  assert.equal(access.level('acct01', 1), undefined);
  await access.refresh('acct01');
  assert.deepEqual([access.level('acct01', 1), access.level('acct01', 2), access.level('acct01', 3)], [ROLE.developer, ROLE.reporter, 0]);
  assert.deepEqual(access.levels('acct01'), { 1: 30, 2: 20 });
  assert.ok(asked.every((a) => a.includes('membership=true')));
  assert.ok(changed.includes('acct01'));
  // Someone signed in to no GitLab is a member of nothing.
  await access.refresh('acct02');
  assert.equal(access.level('acct02', 1), 0);
});

test('setting workers going on a GitLab floor takes Developer; anyone may on the office’s own', async () => {
  const { api } = gitlab();
  const access = new GitLabAccess(() => ({ url: 'https://gl.example', token: 'ana' }), () => {}, api);
  access.projectOf = (f) => f.gitlabProjectId;
  await access.refresh('acct01');
  const ana = { accountId: 'acct01' };
  assert.equal(access.mayWork(ana, { gitlab: 'u', gitlabProjectId: 1 }), undefined);
  assert.match(access.mayWork(ana, { gitlab: 'u', gitlabProjectId: 2 }) ?? '', /a Reporter.*Developer or up/);
  assert.match(access.mayWork(ana, { gitlab: 'u', gitlabProjectId: 3 }) ?? '', /not a member/);
  assert.equal(access.mayWork(ana, {}), undefined);
  // The shared password is the office's own: no GitLab role to ask about.
  assert.equal(access.mayWork({}, { gitlab: 'u', gitlabProjectId: 3 }), undefined);
  // Signed out (or in as someone else): asked again from scratch.
  access.forget('acct01');
  assert.equal(access.level('acct01', 1), undefined);
  assert.deepEqual([roleName(50), roleName(20), roleName(0)], ['Owner', 'Reporter', 'No access']);
});
