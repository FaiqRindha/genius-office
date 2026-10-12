// The building's floors: riding the elevator between them and up to the roof, and adding and taking
// off floors.
import { normalizeRepo, sameRepo } from '../../../shared/floors.js';
import { MAIN_BUILDING, type FloorClientMsg } from '../../../shared/protocol.js';
import { ROOF } from '../../../shared/rooftop.js';
import { arrivalSpot, str } from '../../office/input.js';
import type { HandlerMap, ViewPieces } from './types.js';

export const projectView: ViewPieces['project'] = (_ctx, floor) => floor?.project ?? null;

export const floorHandlers = {
  'floor.go'(ctx, c, msg) {
    if (msg.floor === ROOF) {
      if (ctx.floors.size) ctx.goToRoof(c);
      else ctx.warn(c, 'There is no building to go up on yet');
      return;
    }
    const floor = ctx.floors.get(str(msg.floor, 64));
    if (!floor) ctx.warn(c, ctx.building.pending().some((d) => d.id === msg.floor) ? "That floor is still being cloned — it'll be ready in a moment" : 'No such floor');
    // Into someone else's building only on their guest list (see campus.ts).
    else if (!ctx.campus.mayEnter(c, ctx.campus.of(floor.def))) ctx.warn(c, "That floor's in someone else's building, and your card doesn't open it");
    else ctx.goToFloor(c, floor, arrivalSpot(msg.at));
  },
  'floor.repos'(ctx, c, msg) {
    // The repositories your own GitHub sign-in can see (the office machine's, on the shared password).
    ctx.withGitHub(
      c,
      (as) =>
        void ctx.building.repos(msg.refresh === true, as).then(
          (repos) => ctx.sendTo(c, { t: 'floor.repos', repos }),
          (err: Error) => ctx.sendTo(c, { t: 'floor.repos', repos: [], error: `Couldn't list your repositories with gh: ${err.message}` }),
        ),
      (why) => ctx.sendTo(c, { t: 'floor.repos', repos: [], error: why }),
    );
  },
  'floor.add'(ctx, c, msg) {
    const who = c.peer.name;
    const repo = str(msg.repo, 200);
    // A repository is a floor in one building: say whose, and how to get in there instead.
    const wanted = normalizeRepo(repo);
    const taken = wanted && [...ctx.building.list(), ...ctx.building.pending()].find((d) => sameRepo(d.repo, wanted));
    if (taken) {
      const b = ctx.campus.of(taken);
      const owner = ctx.accounts.get(b)?.name ?? 'its owner';
      const where = b === c.accountId ? 'your building' : b === MAIN_BUILDING ? "the office's own building" : `${owner}'s building`;
      const how = b === c.accountId ? '' : ctx.campus.mayEnter(c, b) ? ': walk over and tap your ID card at its door' : `: ask ${owner} to put you on their guest list`;
      return ctx.sendTo(c, { t: 'floor.added', repo, error: `${wanted} already has a floor in ${where}${how}` });
    }
    // Cloned with your own GitHub sign-in, so a private repository of yours comes down too.
    const add = (as: Parameters<typeof ctx.building.add>[4]) =>
      void ctx.building
        .add(
          repo,
          who,
          (def) => {
            ctx.floorsChanged();
            ctx.toastAll(`🛗 ${who} is adding a floor for ${def.repo ?? def.name}…`);
          },
          c.accountId,
          as,
        )
        .then((r) => {
          ctx.floorsChanged();
          if (typeof r === 'string') return ctx.sendTo(c, { t: 'floor.added', repo, error: r });
          const floor = ctx.openFloor(r);
          if (!floor) return ctx.sendTo(c, { t: 'floor.added', repo, error: `Cloned ${r.repo}, but couldn't open its floor — see the office's log` });
          console.log(`  ${who} added a floor for ${r.repo} (${r.dir})`);
          ctx.toastAll(`🛗 New floor: ${r.name}, added by ${who}`);
          ctx.sendTo(c, { t: 'floor.added', repo, floor: floor.id });
        });
    ctx.withGitHub(c, add, (why) => ctx.sendTo(c, { t: 'floor.added', repo, error: why }));
  },
  'floor.cancel'(ctx, c, msg) {
    const who = c.peer.name;
    const admin = ctx.meOf(c.accountId).admin;
    const id = str(msg.floor, 64);
    const def = ctx.building.pending().find((d) => d.id === id);
    const err = ctx.building.cancel(id, `${who} stopped the clone`, (owner) => admin || (!!owner && owner === c.accountId));
    if (err) ctx.warn(c, err);
    else ctx.toastAll(`🛗 ${who} stopped cloning ${def?.repo ?? def?.name ?? 'a floor'}`);
  },
  'floor.remove'(ctx, c, msg) {
    const who = c.peer.name;
    const id = str(msg.floor, 64);
    // Everyone's workers on it stop: admins do it, or the owner of the building it's in.
    const def = ctx.building.list().find((d) => d.id === id);
    if (!ctx.meOf(c.accountId).admin && !(def && c.accountId && ctx.campus.of(def) === c.accountId)) return ctx.warn(c, 'Only admins, and the owner of its building, can take a floor off it');
    const r = ctx.building.remove(id, who);
    if (typeof r === 'string') return ctx.warn(c, r);
    console.log(`  ${who} took the ${r.name} floor off the building (${r.dir} stays where it is)`);
    const floor = ctx.floors.get(id);
    if (floor) ctx.closeFloor(floor, who);
    else ctx.floorsChanged();
  },
  'floor.projectsDir'(ctx, c, msg) {
    const who = c.peer.name;
    // It's a folder on the office's machine that `gh` writes into: admins pick it.
    const err = ctx.meOf(c.accountId).admin ? ctx.building.setProjectsDir(str(msg.dir, 1024), who) : 'Only admins can move the workspace folder';
    ctx.warn(c, err);
    if (err) return;
    const state = ctx.building.projectsDirState();
    ctx.broadcast({ t: 'projectsDir', state });
    ctx.toastAll(state.custom ? `📁 ${who} moved the workspace folder to ${state.dir}` : `📁 ${who} put the workspace folder back to ${state.dir}`);
  },
} satisfies HandlerMap<FloorClientMsg>;
