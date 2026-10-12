import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { arrange, PERSONAL, type WorldProject } from '../src/shared/gitlab-world.ts';
import { GitLabWorld, projectOf, type Signed } from '../src/server/gitlab-world.ts';
import type { GitLabApi } from '../src/server/gitlab-boards.ts';

const p = (id: number, path: string, extra: Partial<WorldProject> = {}): WorldProject => ({
  id,
  path,
  name: path.split('/').pop()!,
  namespace: path.split('/').slice(0, -1).join('/'),
  archived: false,
  webUrl: `https://akhlak.example/${path}`,
  ...extra,
});

/** What akhlak's elevator showed: every depth there is. */
const AKHLAK = [
  p(1, 'genius/geniusverse'),
  p(2, 'genius/geniusverse/office-test'),
  p(3, 'genius/genius-lab/skynet'),
  p(4, 'genius/genius-lab/mkbot-sky'),
  p(5, 'genius/genius-lab/benchmark_databench'),
  p(6, 'qa/afulabot'),
  p(7, 'genius/genvision/trainer'),
  p(8, 'genius/genvision/snapshot'),
  p(9, 'pge_solutiion/digits-sportainment'),
  p(10, 'a/b/c/deep'),
];

const shape = (r: ReturnType<typeof arrange>) => r.districts.map((d) => [d.key, d.slot, d.buildings.map((b) => [b.name, b.slot, b.floors.map((f) => f.name)])]);

test('every depth of path lands in a district, a building and a floor', () => {
  assert.deepEqual(shape(arrange(AKHLAK)), [
    ['a', 0, [['b › c', 0, ['deep']]]],
    [
      'genius',
      1,
      [
        ['genius HQ', 0, ['geniusverse']],
        ['genius-lab', 1, ['skynet', 'mkbot-sky', 'benchmark_databench']],
        // A project and a subgroup with one name: a floor of the HQ, and a building of its own.
        ['geniusverse', 2, ['office-test']],
        ['genvision', 3, ['trainer', 'snapshot']],
      ],
    ],
    ['pge_solutiion', 2, [['pge_solutiion HQ', 0, ['digits-sportainment']]]],
    ['qa', 3, [['qa HQ', 0, ['afulabot']]]],
  ]);
});

test("what's standing keeps its place when projects come and go", () => {
  const first = arrange(AKHLAK);
  // A new top-level group whose name sorts first, a new subgroup in genius, and genvision gone.
  const later = arrange([...AKHLAK.filter((x) => !x.path.startsWith('genius/genvision')), p(11, 'aaa/new'), p(12, 'genius/alpha/tool')], first.slots);
  const where = (r: ReturnType<typeof arrange>) => Object.fromEntries(r.districts.flatMap((d) => [[`district ${d.key}`, d.slot], ...d.buildings.map((b) => [b.key, `${d.slot}.${b.slot}`])]));
  const before = where(first);
  const after = where(later);
  for (const k of ['district a', 'district genius', 'district qa', 'district pge_solutiion', 'genius', 'genius/genius-lab', 'genius/geniusverse', 'qa', 'a/b/c']) assert.equal(after[k], before[k], k);
  // The newcomers take the first free slots: aaa after the four districts, alpha where genvision was.
  assert.equal(after['district aaa'], 4);
  assert.equal(after['genius/alpha'], '1.3');
});

test('a renamed or moved project is the same floor, moved with it', () => {
  const r = arrange([p(3, 'genius/genvision/skynet-v2'), p(4, 'genius/genius-lab/mkbot-sky')]);
  const floors = r.districts.flatMap((d) => d.buildings.flatMap((b) => b.floors.map((f) => [b.key, f.projectId, f.name])));
  assert.deepEqual(floors, [
    ['genius/genius-lab', 4, 'mkbot-sky'],
    ['genius/genvision', 3, 'skynet-v2'],
  ]);
});

test("archived projects are marked floors; a building with nothing else isn't built", () => {
  const r = arrange([p(1, 'g/live'), p(2, 'g/old', { archived: true }), p(3, 'h/sub/gone', { archived: true })]);
  assert.deepEqual(r.districts.map((d) => [d.key, d.buildings.map((b) => b.floors.map((f) => [f.name, f.archived]))]), [['g', [[['live', false], ['old', true]]]]]);
});

test("personal projects are a district of their own, a building a person", () => {
  const r = arrange([p(1, 'faiq/notes', { personal: true }), p(2, 'g/app')]);
  assert.deepEqual(r.districts.map((d) => [d.key, d.name, d.buildings.map((b) => b.name)]), [
    [PERSONAL, 'Personal projects', ["faiq's projects"]],
    ['g', 'g', ['g HQ']],
  ]);
});

test("GitLab's projects become the world's: their group, not their path, is what counts", () => {
  assert.deepEqual(projectOf({ id: 5, path_with_namespace: 'g/sub/app', name: 'App', namespace: { full_path: 'g/sub', kind: 'group' }, archived: true, web_url: 'u' }), {
    id: 5,
    path: 'g/sub/app',
    name: 'App',
    namespace: 'g/sub',
    archived: true,
    webUrl: 'u',
  });
  assert.equal(projectOf({ id: 6, path_with_namespace: 'faiq/x', namespace: { full_path: 'faiq', kind: 'user' } })?.personal, true);
  assert.equal(projectOf({ id: 'x' }), undefined);
});

/** A GitLab whose tokens each see some projects, a page at a time by id. */
function gitlab(sees: Record<string, number[]>, broken = new Set<string>()) {
  const asked: string[] = [];
  const api: GitLabApi = async (c, _m, rest) => {
    asked.push(`${c.token} ${rest}`);
    if (broken.has(c.token)) throw new Error('akhlak.example stopped taking the GitLab token');
    const after = Number(/id_after=(\d+)/.exec(rest)?.[1] ?? 0);
    const per = Number(/per_page=(\d+)/.exec(rest)?.[1]);
    return (sees[c.token] ?? []).filter((id) => id > after).slice(0, per).map((id) => ({ id, path_with_namespace: `g${id % 3}/p${id}`, namespace: { full_path: `g${id % 3}`, kind: 'group' }, web_url: '' }));
  };
  return { api, asked };
}

const URL_ = 'https://akhlak.example';
const signed = (...tokens: string[]): Signed[] => tokens.map((token, i) => ({ account: `acct00${i}`, url: URL_, token }));

test('the world is every project anyone signed in can see, put together, and kept where it stood', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ao-world-'));
  // 250 projects for one (three pages), and some only another can see.
  const { api, asked } = gitlab({ ana: Array.from({ length: 250 }, (_, i) => i + 1), bo: [3, 400, 401] });
  let changed = 0;
  const world = new GitLabWorld(dir, () => signed('ana', 'bo', 'ana'), () => changed++, api);
  await world.sync();
  const s = world.state()!;
  assert.equal(s.url, URL_);
  assert.equal(s.projects, 252);
  assert.equal(changed, 1);
  // ana's token once, a page at a time.
  assert.deepEqual(asked.filter((a) => a.startsWith('ana')).map((a) => /id_after=(\d+)/.exec(a)![1]), ['0', '100', '200']);
  // A restart: the world stands as it was before anyone looks, in the same places.
  const again = new GitLabWorld(dir, () => [], () => {}, api);
  assert.deepEqual(again.state()?.districts, s.districts);
});

test("one token that stops working doesn't take the projects others can see off the map", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ao-world-'));
  const broken = new Set<string>();
  const { api } = gitlab({ ana: [1, 2], bo: [3] }, broken);
  const world = new GitLabWorld(dir, () => signed('ana', 'bo'), () => {}, api);
  await world.sync();
  assert.equal(world.state()?.projects, 3);
  broken.add('ana');
  await world.sync();
  assert.equal(world.state()?.projects, 1);
  assert.match(world.state()?.error ?? '', /stopped taking/);
  // Nobody's works: the world stays as it was, saying why.
  broken.add('bo');
  await world.sync();
  assert.equal(world.state()?.projects, 1);
});

test('the world is of the GitLab most people are signed in to', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ao-world-'));
  const { api } = gitlab({ a: [1], b: [2], c: [3] });
  const world = new GitLabWorld(dir, () => [...signed('a', 'b'), { account: 'acct009', url: 'https://other.example', token: 'c' }], () => {}, api);
  await world.sync();
  assert.deepEqual([world.state()?.url, world.state()?.projects], [URL_, 2]);
});
