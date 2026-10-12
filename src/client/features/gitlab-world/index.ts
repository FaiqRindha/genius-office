/**
 * The GitLab Quarter: every project on the GitLab its people sign in to, north of the town (see
 * world.ts). It's asked for when you come in, and drawn again whenever the server's look at the
 * GitLab changes it; what's in the way moves round the building you're in, as the campus does.
 */
import type { Ctx } from '../../core/context';
import { store } from '../../state';
import { standsAt } from '../campus/where';

export function installGitLabWorld(ctx: Ctx) {
  const quarter = ctx.office.gitlabWorld;
  ctx.messages.on('welcome', () => ctx.net.send({ t: 'gitlab.world' }));
  store.on('gitlabWorld', () => quarter.set(store.gitlabWorld));
  const here = () => quarter.setHere(standsAt(store.campus.here));
  store.on('campus', here);
  ctx.messages.on('floor.enter', here);
  quarter.set(store.gitlabWorld);
  here();
}
