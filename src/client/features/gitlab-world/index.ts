/**
 * The GitLab Quarter: every project on the GitLab its people sign in to, north of the town (see
 * world.ts). It's asked for when you come in, and drawn again whenever the server's look at the
 * GitLab changes it; what's in the way moves round the building you're in, as the campus does. At a
 * building's door, E opens it: its floors, a project each, by your own GitLab access (see ui.ts).
 */
import type * as THREE from 'three';
import type { Ctx } from '../../core/context';
import { aside, hintTitle, key } from '../../core/hint';
import type { Parts } from '../../core/parts';
import { store } from '../../state';
import { clip } from '../../ui/dom';
import { addPlace, standsAt } from '../campus/where';
import { addBuildingHeight } from '../../core/floors';
import { MAX_FLOORS } from './world';
import { floorReader } from './floor-reader';
import { plotAt } from '../../../shared/gitlab-quarter';
import { addMapLayer, mapChanged } from '../campus/map';
import { quarterLayer } from './map';
import { openBuildingDoor, roleOf } from './ui';

// The kind of thing you can use that this defines (see InteractKinds in world/types.ts).
declare module '../../world/types' {
  interface InteractKinds {
    gitlabdoor: true;
  }
}

export function installGitLabWorld(ctx: Ctx, parts: Pick<Parts, 'travel'>) {
  const quarter = ctx.office.gitlabWorld;
  ctx.messages.on('welcome', () => {
    ctx.net.send({ t: 'gitlab.world' });
    ctx.net.send({ t: 'gitlab.access' });
  });
  // Where your building stands may have come with it (when it's one in the Quarter): the campus puts
  // the world round you again, and the Quarter leaves yours out.
  store.on('gitlabWorld', () => (quarter.set(store.gitlabWorld), mapChanged(), store.emit('campus')));
  // On the map and the minimap too.
  addMapLayer(quarterLayer(() => store.gitlabWorld));
  // A GitLab project's floors stand on their building's plot in the Quarter ("gitlab:<namespace>",
  // see server/campus.ts): there you go in, and there you come out.
  const GITLAB = 'gitlab:';
  const plotOf = (id: string) => {
    if (!id.startsWith(GITLAB)) return undefined;
    const key = id.slice(GITLAB.length);
    for (const d of store.gitlabWorld?.districts ?? []) {
      const b = d.buildings.find((x) => x.key === key);
      if (b) return plotAt(d.cells, b.slot);
    }
    return undefined;
  };
  addPlace(plotOf);
  const insideBuilding = (id: string) => (id.startsWith(GITLAB) ? store.gitlabWorld?.districts.flatMap((d) => d.buildings).find((b) => b.key === id.slice(GITLAB.length)) : undefined);
  // A GitLab building's as tall as it has projects, inside as out (however many are opened yet).
  addBuildingHeight(() => Math.min(MAX_FLOORS, insideBuilding(store.campus.here)?.floors.length ?? 0));
  /** The campus's reader at the foot of the steps of the building you're in: in a GitLab one, the Quarter's is there instead. */
  const homeReader = () => {
    const it = ctx.office.campus.readers[0];
    let post: THREE.Object3D | undefined;
    ctx.scene.traverse((o) => {
      if (o.userData.interact === it) post = o;
    });
    return { it, post };
  };
  // And on every floor of it, a reader beside the elevator: each floor's a project, by your own access.
  const onFloor = floorReader();
  ctx.office.group.add(onFloor.group);
  ctx.usables.add({ usable: () => [onFloor.it] });
  const here = () => {
    const id = store.campus.here;
    const inGitLab = id.startsWith(GITLAB);
    onFloor.show(inGitLab ? id.slice(GITLAB.length) : undefined);
    quarter.setHere(standsAt(id), inGitLab ? id.slice(GITLAB.length) : undefined);
    const home = homeReader();
    if (home.it) home.it.off = inGitLab;
    if (home.post) home.post.visible = !inGitLab;
  };
  store.on('campus', here);
  ctx.messages.on('floor.enter', here);
  quarter.set(store.gitlabWorld);
  here();

  ctx.usables.add({ usable: () => quarter.doors });
  // Only the buildings this side of the fog are drawn: where you are in the world, now and then.
  let culledAt = 0;
  ctx.ticks.add('world', ({ now }) => {
    if (now - culledAt < 500) return;
    culledAt = now;
    const at = ctx.office.grounds.offset();
    quarter.cull({ x: ctx.player.pos.x + at.x, z: ctx.player.pos.z + at.z });
  });
  const buildingOf = (key?: string) => store.gitlabWorld?.districts.flatMap((d) => d.buildings).find((b) => b.key === key);
  let openedAt = 0;
  ctx.interactions.define('gitlabdoor', {
    // From the pavement in front, under the canopy.
    reach: 4,
    hint: (it) => {
      const b = buildingOf(it.gitlabBuilding);
      if (!b) return { k: '', parts: [] };
      const levels = store.gitlabAccess;
      const mine = levels ? b.floors.filter((f) => roleOf(levels[f.projectId])).length : 0;
      return {
        k: `${b.key}|${b.floors.length}|${mine}`,
        parts: [hintTitle(`🦊 ${clip(b.name, 28)}`), aside(`${b.floors.length} project${b.floors.length === 1 ? '' : 's'}${levels ? ` · you're a member of ${mine}` : ''}`), key('E', it.y === 0 ? 'Choose a floor' : 'Go in')],
      };
    },
    use: (it, k) => {
      if (k !== 'E') return;
      const b = buildingOf(it.gitlabBuilding);
      const now = performance.now();
      if (!b || now - openedAt < 600) return;
      openedAt = now;
      openBuildingDoor(ctx.net, b, (floor) => parts.travel.ride(floor));
    },
  });
}
