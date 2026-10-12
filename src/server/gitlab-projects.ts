// The projects someone's GitLab sign-in can see (see gitlab.ts), for the elevator's "add a project",
// and the one they pick, asked about before it's cloned.
import type { GitLabProject } from '../shared/protocol.js';

const PER_PAGE = 100;
const MAX_PROJECTS = 1000;
const TIMEOUT_MS = 30_000;
/** group/project, or group/sub/…/project: GitLab's paths, never a way out of the projects folder. */
const PATH = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)+$/;

/** A GitLab project on its way to becoming a floor. */
export interface GitLabFloorSource {
  /** Its id on the GitLab. */
  id?: number;
  /** The project's page, which is the floor's GitLab (FloorDef.gitlab): https://gitlab.example.com/group/project */
  url: string;
  /** What git clones: the project's page with .git, on the address its owner signed in with. */
  cloneUrl: string;
  /** group/project */
  path: string;
  name: string;
  /** Where the elevator says it comes from: gitlab.example.com */
  host: string;
  /** It has no commits yet, so there's nothing to check out. */
  empty: boolean;
}

/** A project path as typed or picked, tidied; undefined if it isn't one. */
export function gitlabPath(raw: string): string | undefined {
  const s = raw.trim().replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  return s.length <= 255 && PATH.test(s) && !s.split('/').some((p) => p === '.' || p === '..' || p.endsWith('.')) ? s : undefined;
}

async function api(base: string, token: string, rest: string): Promise<Response> {
  return fetch(`${base}/api/v4/${rest}`, { headers: { 'PRIVATE-TOKEN': token }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
}

/** Why GitLab answered `res` the way it did, for the person who asked. */
function refused(res: Response, base: string): string {
  const host = new URL(base).host;
  if (res.status === 401) return `${host} stopped taking your token: paste a new one in 🔐 Your sign-ins`;
  if (res.status === 403) return `Your token can't read projects on ${host}: it needs the api scope`;
  if (res.status === 404) return `${host} has no project there that you can see`;
  return `${host} answered ${res.status}`;
}

/** The projects `token` is a member of on the GitLab at `base`, most recently active first. */
export async function listProjects(base: string, token: string): Promise<GitLabProject[]> {
  const out: GitLabProject[] = [];
  for (let page = 1; out.length < MAX_PROJECTS; page++) {
    const res = await api(base, token, `projects?membership=true&simple=true&archived=false&order_by=last_activity_at&sort=desc&per_page=${PER_PAGE}&page=${page}`);
    if (!res.ok) throw new Error(refused(res, base));
    const items = (await res.json()) as { path_with_namespace?: unknown; name?: unknown; description?: unknown; last_activity_at?: unknown }[];
    for (const p of Array.isArray(items) ? items : []) {
      const path = typeof p.path_with_namespace === 'string' ? gitlabPath(p.path_with_namespace) : undefined;
      if (!path) continue;
      out.push({
        path,
        name: typeof p.name === 'string' && p.name ? p.name.slice(0, 100) : path.split('/').pop()!,
        description: typeof p.description === 'string' && p.description ? p.description.slice(0, 200) : undefined,
        pushedAt: typeof p.last_activity_at === 'string' ? p.last_activity_at : undefined,
      });
    }
    if (!res.headers.get('x-next-page') || !Array.isArray(items) || items.length < PER_PAGE) break;
  }
  return out.slice(0, MAX_PROJECTS);
}

/** Asks the GitLab at `base` about the project at `path`: what to clone, or why it can't. */
export async function findProject(base: string, token: string, path: string): Promise<GitLabFloorSource | string> {
  const host = new URL(base).host;
  try {
    const res = await api(base, token, `projects/${encodeURIComponent(path)}`);
    if (!res.ok) return `Couldn't find ${path} on ${host}: ${refused(res, base)}`;
    const p = (await res.json()) as { id?: unknown; path_with_namespace?: unknown; name?: unknown; empty_repo?: unknown };
    // GitLab's own spelling of the path, in case it was typed in another case.
    const real = typeof p.path_with_namespace === 'string' ? gitlabPath(p.path_with_namespace) : undefined;
    if (!real) return `${host} doesn't look like a GitLab`;
    const url = `${base}/${real}`;
    return { ...(typeof p.id === 'number' ? { id: p.id } : {}), url, cloneUrl: `${url}.git`, path: real, name: typeof p.name === 'string' && p.name ? p.name.slice(0, 100) : real.split('/').pop()!, host, empty: p.empty_repo === true };
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    return `Couldn't reach ${host}: ${cause?.code ?? cause?.message ?? (err as Error).message}`;
  }
}

/** Why a clone from a GitLab failed, from what git said. */
export function whyGitLabCloneFailed(output: string, host: string): string {
  const said = output
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter((l) => l && !/^Cloning into |^(?:remote: )?[A-Z][a-z]+ [a-z]+:\s+\d/.test(l));
  const all = said.join('\n');
  if (/terminal prompts disabled|could not read (Username|Password)|Authentication failed|HTTP Basic: Access denied/i.test(all)) return `${host} didn't take your token for git: it needs the read_repository (or write_repository) scope`;
  if (/SSL certificate problem|unable to get local issuer/i.test(all)) return `git doesn't trust ${host}'s certificate: add its CA to the office machine (git config http.sslCAInfo)`;
  return said.slice(-2).join(' ') || 'git clone failed';
}
