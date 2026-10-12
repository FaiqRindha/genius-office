// Your own self-hosted GitLab (see gitlab.ts): signing in to it, and adding its projects as floors
// (see gitlab-projects.ts). Accounts only: the shared password runs on the office's.
import type { GitLabClientMsg } from '../../../shared/protocol.js';
import type { Ctx } from '../../office/context.js';
import type { Client } from '../../office/client.js';
import { num, str } from '../../office/input.js';
import { ROLE } from '../../gitlab-access.js';
import { childEnv } from '../../workers.js';
import { findProject, gitlabPath } from '../../gitlab-projects.js';
import type { HandlerMap } from './types.js';
import { alreadyAFloor } from './floors.js';

/** The account `c` is signed in with; on the shared password there's none, and they're told why. */
const accountOf = (ctx: Ctx, c: Client): string | undefined => {
  const id = c.accountId;
  if (!id) ctx.warn(c, "On the shared office password, workers run on the office's own GitLab sign-in");
  return id;
};

export const gitlabHandlers = {
  'gitlab.get'(ctx, c) {
    const id = accountOf(ctx, c);
    if (!id) return;
    ctx.sendTo(c, { t: 'gitlab', state: ctx.gitlab.state(id) });
    void ctx.gitlab.look(id);
  },
  'gitlab.token'(ctx, c, msg) {
    const id = accountOf(ctx, c);
    if (!id) return;
    // One of GitHub and GitLab at a time, so the office only ever offers you the one you use.
    const github = ctx.signins.githubLogin(id);
    if (github) return ctx.warn(c, `You're signed in to GitHub as @${github}: sign out of it first to use GitLab instead`);
    // Why a token didn't take shows on the GitLab card.
    void ctx.gitlab.token(id, str(msg.url, 2048), str(msg.token, 4096));
  },
  'gitlab.signout'(ctx, c) {
    const id = accountOf(ctx, c);
    if (!id) return;
    ctx.gitlab.signOut(id);
  },
  'gitlab.access'(ctx, c) {
    const id = c.accountId;
    if (!id) return ctx.sendTo(c, { t: 'gitlab.access', levels: {} });
    ctx.sendTo(c, { t: 'gitlab.access', levels: ctx.gitlabAccess.levels(id) });
    // Looked at again; their browsers hear the answer (see GitLabAccess's onChange).
    void ctx.gitlabAccess.refresh(id);
  },
  'gitlab.enter'(ctx, c, msg) {
    const id = accountOf(ctx, c);
    if (!id) return;
    const projectId = num(msg.projectId);
    const answer = (r: { floor?: string; error?: string }) => ctx.sendTo(c, { t: 'gitlab.entered', projectId, ...r });
    const project = ctx.gitlabWorld.project(projectId);
    if (!project) return answer({ error: "That project isn't in the GitLab Quarter (any more)" });
    const who = c.peer.name;
    void (async () => {
      // Their role, asked afresh if it's never been: a member (Guest and up) goes in.
      if (ctx.gitlabAccess.level(id, projectId) === undefined) await ctx.gitlabAccess.refresh(id);
      if ((ctx.gitlabAccess.level(id, projectId) ?? 0) < ROLE.guest) return answer({ error: `You're not a member of ${project.path} on GitLab, so its floor stays locked to you` });
      const tidy = (u: string) => u.replace(/\/+$/, '').toLowerCase();
      const ours = (d: { gitlab?: string; gitlabProjectId?: number }) => d.gitlabProjectId === projectId || (!!d.gitlab && !!project.webUrl && tidy(d.gitlab) === tidy(project.webUrl));
      const def = ctx.building.list().find(ours);
      if (def) {
        const floor = ctx.floors.get(def.id) ?? ctx.openFloor(def);
        return answer(floor ? { floor: floor.id } : { error: `Couldn't open ${project.path}'s floor — see the office's log` });
      }
      if (ctx.building.pending().some(ours)) return answer({ error: `${project.path} is being cloned: try again in a moment` });
      // Not cloned yet: cloned now, with their own token, and its floor opened.
      const creds = ctx.gitlab.creds(id);
      if (!creds) return answer({ error: 'Sign in to GitLab first (☰ → 🔐 Your sign-ins)' });
      const src = await findProject(creds.url, creds.token, project.path);
      if (typeof src === 'string') return answer({ error: src });
      const r = await ctx.building.addGitLab(
        { ...src, id: projectId },
        ctx.gitlab.apply(id, childEnv()),
        who,
        () => {
          ctx.floorsChanged();
          ctx.toastAll(`🦊 ${who} is opening ${project.path} in the GitLab Quarter…`);
        },
        id,
      );
      ctx.floorsChanged();
      if (typeof r === 'string') return answer({ error: r });
      const floor = ctx.openFloor(r);
      if (!floor) return answer({ error: `Cloned ${project.path}, but couldn't open its floor — see the office's log` });
      console.log(`  ${who} opened ${project.path} in the GitLab Quarter (${r.dir})`);
      answer({ floor: floor.id });
    })();
  },
  'gitlab.world'(ctx, c) {
    // Everyone sees the city; who may go into a floor is another matter (later: their own GitLab access).
    ctx.sendTo(c, { t: 'gitlab.world', state: ctx.gitlabWorld.state() ?? null });
  },
  'gitlab.projects'(ctx, c, msg) {
    const id = accountOf(ctx, c);
    if (!id) return;
    void ctx.gitlab.projects(id, msg.refresh === true).then(
      (projects) => ctx.sendTo(c, { t: 'gitlab.projects', projects }),
      (err: Error) => ctx.sendTo(c, { t: 'gitlab.projects', projects: [], error: `Couldn't list your GitLab projects: ${err.message}` }),
    );
  },
  'gitlab.add'(ctx, c, msg) {
    const id = accountOf(ctx, c);
    if (!id) return;
    const who = c.peer.name;
    const asked = str(msg.path, 255);
    const answer = (r: { floor?: string; error?: string }) => ctx.sendTo(c, { t: 'gitlab.added', path: asked, ...r });
    const path = gitlabPath(asked);
    if (!path) return answer({ error: 'Pick a project, or type it as group/project' });
    const creds = ctx.gitlab.creds(id);
    if (!creds) return answer({ error: 'Sign in to GitLab first (☰ → 🔐 Your sign-ins)' });
    void (async () => {
      // Asking GitLab first says whether this sign-in can see it at all, and gets the path's real case.
      const src = await findProject(creds.url, creds.token, path);
      if (typeof src === 'string') return answer({ error: src });
      // A project is a floor in one building: say whose, and how to get in there instead.
      const taken = [...ctx.building.list(), ...ctx.building.pending()].find((d) => d.gitlab?.toLowerCase() === src.url.toLowerCase());
      if (taken) return answer({ error: alreadyAFloor(ctx, c, taken, src.path) });
      const r = await ctx.building.addGitLab(
        src,
        ctx.gitlab.apply(id, childEnv()),
        who,
        () => {
          ctx.floorsChanged();
          ctx.toastAll(`🛗 ${who} is adding a floor for ${src.path}…`);
        },
        id,
      );
      ctx.floorsChanged();
      if (typeof r === 'string') return answer({ error: r });
      const floor = ctx.openFloor(r);
      if (!floor) return answer({ error: `Cloned ${src.path}, but couldn't open its floor — see the office's log` });
      console.log(`  ${who} added a floor for ${src.url} (${r.dir})`);
      ctx.toastAll(`🛗 New floor: ${r.name}, added by ${who}`);
      answer({ floor: floor.id });
    })();
  },
} satisfies HandlerMap<GitLabClientMsg>;
