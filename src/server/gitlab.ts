import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { GitLabProject, GitLabState } from '../shared/protocol.js';
import { listProjects as askProjects } from './gitlab-projects.js';
import { addGitCredentials, gitlabEnv } from './forge.js';
import type { RunAs } from './workers/types.js';
import type { GhAs } from './signins.js';

/*
 * Everyone's own GitLab
 * ---------------------
 * Next to their Claude and GitHub (see signins.ts), someone with an account can sign in to a
 * self-hosted GitLab: its address and a personal access token, which the office checks against
 * GitLab's API before it keeps it, in .agent-office/homes/<id>/gitlab.json. Their workers then get
 * it in their environment the way glab reads it (GITLAB_HOST, GITLAB_TOKEN), and git gets it as the
 * credentials for that GitLab, so `git push` and `glab mr create` go out as them.
 *
 * The office machine's own GitLab credentials never reach a worker hired by an account, signed in
 * to GitLab or not. An office without accounts never comes here: its workers use the machine's own.
 */

/** What the office's own environment may carry for GitLab and glab. */
const GITLAB_VARS = ['GITLAB_TOKEN', 'GITLAB_ACCESS_TOKEN', 'OAUTH_TOKEN', 'GITLAB_HOST', 'GITLAB_URI', 'GL_HOST', 'GLAB_CONFIG_DIR'];
/** glpat-…, and GitLab's other token shapes. */
const TOKEN = /^[A-Za-z0-9_.-]{16,512}$/;
const ACCOUNT_ID = /^[A-Za-z0-9]{6,64}$/;
const LOOK_GAP_MS = 60_000;
/** How long the projects someone's GitLab can see are reused before it's asked again. */
const PROJECTS_TTL_MS = 5 * 60_000;
const LOOK_TIMEOUT_MS = 15_000;

interface Saved {
  url: string;
  token: string;
  who?: string;
}

/** Asks GitLab who a token is: its user, or why not (`signedOut` when GitLab turned the token down). */
export type GitLabWhoAmI = (url: string, token: string) => Promise<{ username: string } | { error: string; signedOut?: boolean }>;

/** A GitLab's address as typed (gitlab.example.com, https://gitlab.example.com/), made whole; undefined if it isn't one. */
export function gitlabUrl(raw: string): string | undefined {
  let s = raw.trim();
  if (!s) return undefined;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return undefined;
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.search || u.hash) return undefined;
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

export const whoAmI: GitLabWhoAmI = async (url, token) => {
  try {
    const res = await fetch(`${url}/api/v4/user`, { headers: { 'PRIVATE-TOKEN': token }, signal: AbortSignal.timeout(LOOK_TIMEOUT_MS), redirect: 'error' });
    if (res.status === 401 || res.status === 403) return { error: `${new URL(url).host} didn't take that token: make one with the api and write_repository scopes`, signedOut: true };
    if (!res.ok) return { error: `${new URL(url).host} answered ${res.status}: is that the address of your GitLab?` };
    const user = (await res.json()) as { username?: unknown };
    return typeof user.username === 'string' && user.username ? { username: user.username } : { error: `${new URL(url).host} doesn't look like a GitLab` };
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    return { error: `Couldn't reach ${new URL(url).host}: ${cause?.code ?? cause?.message ?? (err as Error).message}` };
  }
};

export class GitLabSignIns {
  private homes: string;
  private live = new Map<string, { state: GitLabState; lookedAt: number; looking?: Promise<void> }>();
  private projectCache = new Map<string, { at: number; token: string; projects: Promise<GitLabProject[]> }>();

  constructor(
    dataDir: string,
    private onChange: (accountId: string) => void,
    private ask: GitLabWhoAmI = whoAmI,
    private listProjects: typeof askProjects = askProjects,
  ) {
    this.homes = path.join(dataDir, 'homes');
  }

  state(id: string): GitLabState {
    return this.get(id).state;
  }

  /** The GitLab `id` is signed in to, and its token; undefined when they aren't. */
  creds(id: string): { url: string; token: string } | undefined {
    const s = this.load(id);
    return s && { url: s.url, token: s.token };
  }

  /**
   * How the office acts on a GitLab floor for `id` (see gitlab-boards.ts): their own GitLab, or why
   * it can't. Shaped like GitHub's (SignIns.ghAs), so the boards take either.
   */
  ghAs(id: string): GhAs | string {
    const s = this.load(id);
    if (!s) return 'Sign in to GitLab first (☰ → 🔐 Your sign-ins): the office acts on GitLab as you';
    // The whole environment, as GitHub's is: git pushes with it too.
    return { key: `gitlab:${id}`, env: gitlabEnv(process.env, s) };
  }

  /**
   * Who reads the boards of the GitLab project at `project`: `prefer` (the account that added it)
   * while it's signed in to that GitLab, else anyone who is. Undefined when nobody is.
   */
  reader(project: string, prefer?: string): { url: string; token: string } | undefined {
    const on = (s: Saved | undefined) => !!s && project.toLowerCase().startsWith(`${s.url.toLowerCase()}/`);
    const first = prefer && ACCOUNT_ID.test(prefer) ? this.load(prefer) : undefined;
    if (on(first)) return { url: first!.url, token: first!.token };
    let ids: string[] = [];
    try {
      ids = readdirSync(this.homes).filter((n) => ACCOUNT_ID.test(n)).sort();
    } catch {
      // nobody has signed in to anything yet
    }
    for (const id of ids) {
      const s = this.load(id);
      if (on(s)) return { url: s!.url, token: s!.token };
    }
    return undefined;
  }

  /** The projects `id`'s GitLab sign-in can see, most recently active first (asked afresh with `refresh`). */
  projects(id: string, refresh = false): Promise<GitLabProject[]> {
    const s = this.load(id);
    if (!s) return Promise.reject(new Error('Sign in to GitLab first (☰ → 🔐 Your sign-ins)'));
    const cached = this.projectCache.get(id);
    if (cached && !refresh && cached.token === s.token && Date.now() - cached.at < PROJECTS_TTL_MS) return cached.projects;
    const projects = this.listProjects(s.url, s.token);
    this.projectCache.set(id, { at: Date.now(), token: s.token, projects });
    // A failure is worth asking again next time, not keeping for five minutes.
    projects.catch(() => {
      if (this.projectCache.get(id)?.projects === projects) this.projectCache.delete(id);
    });
    return projects;
  }

  /** Looks at whether `id`'s token still works, now if `force`, else unless it just did. */
  look(id: string, force = false): Promise<void> {
    const l = this.get(id);
    if (l.looking) return l.looking;
    if (!force && Date.now() - l.lookedAt < LOOK_GAP_MS) return Promise.resolve();
    const s = this.load(id);
    if (!s) return Promise.resolve();
    l.looking = this.ask(s.url, s.token).then((r) => {
      l.lookedAt = Date.now();
      l.looking = undefined;
      // Signed out or changed meanwhile: this look is about a token that's gone.
      if (this.load(id)?.token !== s.token) return;
      if ('username' in r) l.state = { status: 'ok', url: s.url, who: `@${r.username}` };
      else if (r.signedOut) l.state = { status: 'none', url: s.url, error: 'GitLab stopped taking your token: paste a new one' };
      else l.state = { status: s.who ? 'ok' : 'none', url: s.url, who: s.who, error: r.error };
      this.onChange(id);
    });
    return l.looking;
  }

  /**
   * A personal access token for the GitLab at `rawUrl`: kept once GitLab takes it. Resolves to why
   * it didn't, which the card shows too.
   */
  async token(id: string, rawUrl: string, rawToken: string): Promise<string | undefined> {
    const l = this.get(id);
    const before = { ...l.state, error: undefined };
    const refuse = (error: string) => {
      l.state = { ...before, error };
      this.onChange(id);
      return error;
    };
    const url = gitlabUrl(rawUrl);
    if (!url) return refuse("That isn't the address of a GitLab (https://gitlab.example.com)");
    const token = rawToken.trim();
    if (!TOKEN.test(token)) return refuse("That doesn't look like a GitLab token (glpat-…)");
    l.state = { status: 'busy', url };
    this.onChange(id);
    const r = await this.ask(url, token);
    if (!('username' in r)) return refuse(r.error);
    const who = `@${r.username}`;
    this.save(id, { url, token, who });
    l.state = { status: 'ok', url, who };
    l.lookedAt = Date.now();
    this.onChange(id);
    return undefined;
  }

  signOut(id: string) {
    this.save(id, undefined);
    this.projectCache.delete(id);
    this.get(id).state = { status: 'none' };
    this.onChange(id);
  }

  /** Puts `id`'s own GitLab in place of the office's in `env` (changed in place, and returned). */
  apply(id: string, env: Record<string, string>): Record<string, string> {
    for (const k of GITLAB_VARS) delete env[k];
    if (!ACCOUNT_ID.test(id)) return env;
    // glab's own config, so the machine's glab login stays the machine's.
    const glab = path.join(this.homes, id, 'glab');
    try {
      mkdirSync(glab, { recursive: true, mode: 0o700 });
    } catch {
      // glab makes it itself when it can
    }
    env.GLAB_CONFIG_DIR = glab;
    const s = this.load(id);
    if (!s) return env;
    env.GITLAB_HOST = s.url;
    env.GITLAB_TOKEN = s.token;
    addGitCredentials(env, s.url);
    return env;
  }

  // ---------------------------------------------------------------------------

  private get(id: string) {
    let l = this.live.get(id);
    if (!l) {
      const s = this.load(id);
      l = { state: s ? { status: s.who ? 'ok' : 'none', url: s.url, who: s.who } : { status: 'none' }, lookedAt: 0 };
      this.live.set(id, l);
    }
    return l;
  }

  private file(id: string): string {
    if (!ACCOUNT_ID.test(id)) throw new Error(`not an account id: ${id}`);
    return path.join(this.homes, id, 'gitlab.json');
  }

  private load(id: string): Saved | undefined {
    try {
      const s = JSON.parse(readFileSync(this.file(id), 'utf8')) as Partial<Saved> | null;
      return s && typeof s.url === 'string' && typeof s.token === 'string' ? (s as Saved) : undefined;
    } catch {
      return undefined;
    }
  }

  private save(id: string, s: Saved | undefined) {
    const file = this.file(id);
    try {
      if (!s) return rmSync(file, { force: true });
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, JSON.stringify(s, null, 2), { mode: 0o600 });
    } catch (err) {
      console.error(`agent-office: couldn't save ${id}'s GitLab sign-in: ${(err as Error).message}`);
    }
  }
}

/** The account's sign-ins for its workers (see signins.ts), with its GitLab on top. */
export function withGitLab(runAs: RunAs, gitlab: GitLabSignIns): RunAs {
  return {
    claudeReady: (owner) => runAs.claudeReady(owner),
    why: (which) => runAs.why(which),
    apply: (owner, env, dirs) => gitlab.apply(owner, runAs.apply(owner, env, dirs)),
  };
}
