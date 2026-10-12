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

test("the Quarter's cells stand on land, clear of the beach, and a whole office building fits every plot", async () => {
  const { cellAt, plotAt, inQuarter, QUARTER, PER_CELL, CELLS, STREET_W } = await import('../src/shared/gitlab-quarter.ts');
  const { shoreX } = await import('../src/shared/scenic.ts');
  assert.equal(CELLS, 30);
  assert.equal(PER_CELL, 6);
  // Past them, a district isn't put up off the edge of the world.
  assert.equal(plotAt([CELLS], 0), undefined);
  for (let c = 0; c < CELLS; c++) {
    const at = cellAt(c);
    assert.ok(at.x - QUARTER.cellW / 2 > shoreX(at.z) + 26, `cell ${c} is in the sea`);
    assert.ok(at.z - QUARTER.cellD / 2 >= QUARTER.minZ, `cell ${c} is off the map`);
    for (let i = 0; i < PER_CELL; i++) {
      const p = plotAt([c], i)!;
      // An office building, from its card reader to its east wall and from its wing to its steps,
      // inside its cell's streets (see BLOCK).
      assert.ok(p.x - 20.5 > at.x - QUARTER.cellW / 2 + STREET_W / 2 && p.x + 18.3 < at.x + QUARTER.cellW / 2 - STREET_W / 2, `plot ${i} of cell ${c} across`);
      assert.ok(p.z - 22.2 > at.z - QUARTER.cellD / 2 + STREET_W / 2 && p.z + 13.3 < at.z + QUARTER.cellD / 2 - STREET_W / 2 + 0.01, `plot ${i} of cell ${c} deep`);
      assert.ok(inQuarter(p.x, p.z));
    }
  }
  // The road up from town is clear of trees too, and the town isn't the Quarter.
  assert.ok(inQuarter(-34, -150));
  assert.equal(inQuarter(0, 0), false);
});

test('a district with more buildings than a cell holds takes another, and nobody moves', () => {
  const many = Array.from({ length: 20 }, (_, i) => p(100 + i, `big/sub${String(i).padStart(2, '0')}/app`));
  const first = arrange([p(1, 'aaa/x'), ...many.slice(0, 10)]);
  const cellsOf = (r: ReturnType<typeof arrange>) => Object.fromEntries(r.districts.map((d) => [d.key, d.cells]));
  // Six buildings a cell: big's ten take two.
  assert.deepEqual(cellsOf(first), { aaa: [0], big: [1, 2] });
  const later = arrange([p(1, 'aaa/x'), ...many, p(200, 'zzz/y')], first.slots);
  // A new district's first cell comes before anyone's next: zzz gets 3, big's third and fourth 4 and 5.
  assert.deepEqual(cellsOf(later), { aaa: [0], big: [1, 2, 4, 5], zzz: [3] });
});

test("the Quarter's roads are one network, joined to the main street, and a car drives every one of them", async () => {
  const { QUARTER_ROADS, QUARTER_PATH, QUARTER, onQuarterRoad } = await import('../src/shared/gitlab-quarter.ts');
  const { onPavement, paved } = await import('../src/shared/garage.ts');
  const { ROAD } = await import('../src/shared/layout.ts');
  // Every stretch meets another, all the way back to the road up from the main street.
  const touch = (a: (typeof QUARTER_ROADS)[number], b: (typeof QUARTER_ROADS)[number]) => a.minX <= b.maxX && b.minX <= a.maxX && a.minZ <= b.maxZ && b.minZ <= a.maxZ;
  const reached = new Set([0]);
  for (let grew = true; grew; ) {
    grew = false;
    QUARTER_ROADS.forEach((r, i) => {
      if (!reached.has(i) && [...reached].some((j) => touch(QUARTER_ROADS[j], r))) (reached.add(i), (grew = true));
    });
  }
  assert.equal(reached.size, QUARTER_ROADS.length);
  // The way up starts on the main street.
  assert.ok(QUARTER_ROADS[0].maxZ >= ROAD.minZ && paved(QUARTER_PATH.x, (ROAD.minZ + ROAD.maxZ) / 2));
  // A car fits down the middle of every stretch, either way it's pointing.
  for (const r of QUARTER_ROADS) {
    const along = r.maxX - r.minX > r.maxZ - r.minZ;
    const cx = (r.minX + r.maxX) / 2;
    const cz = (r.minZ + r.maxZ) / 2;
    for (let t = 0.04; t < 1; t += 0.04) {
      const x = along ? r.minX + (r.maxX - r.minX) * t : cx;
      const z = along ? cz : r.minZ + (r.maxZ - r.minZ) * t;
      for (const rotY of along ? [Math.PI / 2, -Math.PI / 2] : [0, Math.PI]) assert.ok(onPavement({ x, z, rotY }), `car at ${x.toFixed(0)},${z.toFixed(0)}`);
    }
  }
  // Off the roads is still the meadow (and the lawn the garage test keeps unpaved stays so).
  assert.equal(onQuarterRoad(QUARTER_PATH.x + 20, -150), false);
  assert.equal(onPavement({ x: -40, z: 18, rotY: 0 }), false);
  assert.ok(onQuarterRoad(QUARTER.x, QUARTER.z - 500));
});

test("nothing of the Quarter's stands on its roads, and every garage opens onto one", async () => {
  const { QUARTER_ROADS, QUARTER_GARAGES, plotAt, PER_CELL, CELLS } = await import('../src/shared/gitlab-quarter.ts');
  const { onPavement } = await import('../src/shared/garage.ts');
  const overlaps = (a: { minX: number; maxX: number; minZ: number; maxZ: number }) => QUARTER_ROADS.some((r) => a.minX < r.maxX && r.minX < a.maxX && a.minZ < r.maxZ && r.minZ < a.maxZ);
  for (let c = 0; c < CELLS; c++) {
    for (let i = 0; i < PER_CELL; i++) {
      const at = plotAt([c], i)!;
      // The office building that stands on it, inside or out (reader to east wall, wing to steps).
      assert.equal(overlaps({ minX: at.x - 20.5, maxX: at.x + 18.3, minZ: at.z - 22.2, maxZ: at.z + 13.3 }), false, `office on plot ${i} of cell ${c}`);
    }
  }
  // From each garage a car drives straight out onto its road: from its back, south to the road.
  for (const g of QUARTER_GARAGES.slice(0, 12)) {
    const x = (g.minX + g.maxX) / 2;
    for (let z = g.minZ + 3; z < g.maxZ + 4; z += 1) assert.ok(onPavement({ x, z, rotY: 0 }), `garage at ${x},${z}`);
  }
});

test("a GitLab floor you're not a member of is locked in the elevator; one you are, or that isn't GitLab's, isn't", async () => {
  const { store } = await import('../src/client/state/index.ts');
  const { gitlabLocked } = await import('../src/client/ui/elevator-gitlab.ts');
  const world = arrange([p(7, 'g/sub/app'), p(8, 'g/sub/tool')]);
  store.gitlabWorld = { url: 'https://akhlak.example', districts: world.districts, projects: 2, syncedAt: 0 };
  // Your roles not in yet: not locked (the office checks when you go).
  store.gitlabAccess = null;
  assert.equal(gitlabLocked({ gitlab: 'https://akhlak.example/g/sub/app' }), false);
  store.gitlabAccess = { 7: 30 };
  assert.equal(gitlabLocked({ gitlab: 'https://akhlak.example/g/sub/app' }), false);
  assert.equal(gitlabLocked({ gitlab: 'https://akhlak.example/g/sub/tool' }), true);
  assert.equal(gitlabLocked({}), false);
});
