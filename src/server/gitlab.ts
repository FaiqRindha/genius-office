import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { GitLabState } from '../shared/protocol.js';
import type { RunAs } from './workers/types.js';

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
const LOOK_TIMEOUT_MS = 15_000;
/** git asks it for a password for the GitLab, and it answers with the token in the worker's environment. */
const CREDENTIAL_HELPER = `!f() { test "$1" = get && printf 'username=oauth2\\npassword=%s\\n' "$GITLAB_TOKEN"; }; f`;

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

  constructor(
    dataDir: string,
    private onChange: (accountId: string) => void,
    private ask: GitLabWhoAmI = whoAmI,
  ) {
    this.homes = path.join(dataDir, 'homes');
  }

  state(id: string): GitLabState {
    return this.get(id).state;
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
    // Added to whatever git config the environment already carries: '' clears the helpers before it.
    const n = Number(env.GIT_CONFIG_COUNT) || 0;
    const key = `credential.${new URL(s.url).origin}.helper`;
    env[`GIT_CONFIG_KEY_${n}`] = key;
    env[`GIT_CONFIG_VALUE_${n}`] = '';
    env[`GIT_CONFIG_KEY_${n + 1}`] = key;
    env[`GIT_CONFIG_VALUE_${n + 1}`] = CREDENTIAL_HELPER;
    env.GIT_CONFIG_COUNT = String(n + 2);
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
