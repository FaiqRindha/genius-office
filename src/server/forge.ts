// Which floors' projects are on a self-hosted GitLab, by where their checkouts are, so the git and
// pull request plumbing that only knows a folder (worktrees fetching, workers' pull requests, the
// Changes window) can ask whether it's a GitLab's and with whose token. GitHub's needs none of this:
// gh works it out from the checkout.
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { gitlabApi, type GitLabApi, type GitLabCreds } from './gitlab-boards.js';

/** A floor whose project is on a GitLab. */
export interface GitLabFloor {
  /** The project's page: https://gitlab.example.com/group/project */
  project: string;
  /** Who reads it (see GitLabSignIns.reader): for what's done with nobody's own token. */
  reader(): GitLabCreds | undefined;
}

const floors = new Map<string, GitLabFloor>();

function real(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

/** The floor checked out at `dir` is `floor`'s GitLab project (undefined: it isn't, any more). */
export function setGitLabFloor(dir: string, floor: GitLabFloor | undefined) {
  if (floor) floors.set(real(dir), floor);
  else floors.delete(real(dir));
}

/** The GitLab floor `dir` is in (its checkout, or a worktree in it), if it's in one. */
export function gitlabFloorAt(dir: string): GitLabFloor | undefined {
  const at = real(dir);
  let best: [string, GitLabFloor] | undefined;
  for (const [root, f] of floors) {
    const rel = path.relative(root, at);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    if (!best || root.length > best[0].length) best = [root, f];
  }
  return best?.[1];
}

/** git asks it for a password for the GitLab, and it answers with $GITLAB_TOKEN. */
const CREDENTIAL_HELPER = `!f() { test "$1" = get && printf 'username=oauth2\\npassword=%s\\n' "$GITLAB_TOKEN"; }; f`;

/**
 * Has git use $GITLAB_TOKEN as the password for the GitLab at `url`, on top of whatever git config
 * `env` already carries ('' clears the helpers before it). Changes `env` in place.
 */
export function addGitCredentials(env: Record<string, string>, url: string) {
  const n = Number(env.GIT_CONFIG_COUNT) || 0;
  const key = `credential.${new URL(url).origin}.helper`;
  env[`GIT_CONFIG_KEY_${n}`] = key;
  env[`GIT_CONFIG_VALUE_${n}`] = '';
  env[`GIT_CONFIG_KEY_${n + 1}`] = key;
  env[`GIT_CONFIG_VALUE_${n + 1}`] = CREDENTIAL_HELPER;
  env.GIT_CONFIG_COUNT = String(n + 2);
}

/** `base` (the whole environment) with a GitLab token in it, as glab and git (pushing, fetching) take it. */
export function gitlabEnv(base: NodeJS.ProcessEnv, c: GitLabCreds): Record<string, string> {
  const env = Object.fromEntries(Object.entries(base).filter((e): e is [string, string] => e[1] !== undefined));
  env.GITLAB_HOST = c.url;
  env.GITLAB_TOKEN = c.token;
  addGitCredentials(env, c.url);
  return env;
}

/** The creds in an environment from gitlabEnv (someone's own GitLab), else the floor's reader. */
export function credsFor(floor: GitLabFloor, env?: Record<string, string>): GitLabCreds | undefined {
  const url = env?.GITLAB_HOST;
  const token = env?.GITLAB_TOKEN;
  return url && token ? { url, token } : floor.reader();
}

/** The environment to push to the floor's GitLab with: `env` when it's someone's own, else the reader's. */
export function pushEnv(floor: GitLabFloor, env?: Record<string, string>): Record<string, string> | undefined {
  if (env?.GITLAB_TOKEN) return env;
  const c = floor.reader();
  return c ? gitlabEnv(env ?? process.env, c) : env;
}

/** The floor's project path on the GitLab `c` is for: group/project. */
function projectId(floor: GitLabFloor, c: GitLabCreds): string {
  const base = `${c.url.toLowerCase()}/`;
  if (!floor.project.toLowerCase().startsWith(base)) throw new Error(`The GitLab sign-in is for ${new URL(c.url).host}, not ${new URL(floor.project).host}`);
  return encodeURIComponent(floor.project.slice(base.length));
}

function must(floor: GitLabFloor, env?: Record<string, string>): GitLabCreds {
  const c = credsFor(floor, env);
  if (!c) throw new Error(`Nobody signed in to ${new URL(floor.project).host} can open merge requests on ${floor.project} — sign in to GitLab (☰ → 🔐 Your sign-ins)`);
  return c;
}

/** The open merge request from `branch`, if there is one. */
export async function openMr(floor: GitLabFloor, branch: string, env?: Record<string, string>, api: GitLabApi = gitlabApi): Promise<{ number: number; url: string } | undefined> {
  const c = must(floor, env);
  const found = await api(c, 'GET', `projects/${projectId(floor, c)}/merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}&per_page=1`);
  const m = Array.isArray(found) ? found[0] : undefined;
  return m ? { number: Number(m.iid), url: String(m.web_url) } : undefined;
}

/** Opens a merge request from the pushed `branch` into `base` (none: the project's default branch). */
export async function createMr(floor: GitLabFloor, branch: string, base: string | undefined, title: string, body: string, env?: Record<string, string>, api: GitLabApi = gitlabApi): Promise<{ number: number; url: string }> {
  const c = must(floor, env);
  const id = projectId(floor, c);
  const target = base ?? String((await api(c, 'GET', `projects/${id}`))?.default_branch ?? 'main');
  const m = await api(c, 'POST', `projects/${id}/merge_requests`, { source_branch: branch, target_branch: target, title, description: body, remove_source_branch: true });
  return { number: Number(m.iid), url: String(m.web_url) };
}

/** A merge request's description, changed by `edit` (for the list of a change's other pull requests). */
export async function editMrBody(floor: GitLabFloor, number: number, edit: (body: string) => string, env?: Record<string, string>, api: GitLabApi = gitlabApi) {
  const c = must(floor, env);
  const id = projectId(floor, c);
  const body = String((await api(c, 'GET', `projects/${id}/merge_requests/${number}`))?.description ?? '');
  const next = edit(body);
  if (next !== body) await api(c, 'PUT', `projects/${id}/merge_requests/${number}`, { description: next });
}
