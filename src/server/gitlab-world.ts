import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { arrange, type WorldProject, type WorldSlots, type WorldState } from '../shared/gitlab-world.js';
import { gitlabApi, type GitLabApi, type GitLabCreds } from './gitlab-boards.js';

/*
 * The GitLab world, kept up to date (see shared/gitlab-world.ts for how it's laid out)
 * -------------------------------------------------------------------------------------
 * Every project the office can see on the GitLab its people sign in to stands in the city. The
 * office sees what their tokens see: it lists the projects with each one (GitLab shows a token the
 * projects its user may see, members' and internal ones alike) and puts them together, so the world
 * is as complete as the people signed in to it can see. It looks again every few minutes, and soon
 * after someone signs in or out. Where each district and building stands is kept in
 * .agent-office/gitlab-world.json, so the city doesn't rearrange itself.
 */

const SYNC_MS = 5 * 60_000;
/** After a sign-in changes, a look this soon (several at once are one). */
const SOON_MS = 3_000;
const PER_PAGE = 100;
/** Ten thousand projects: past that, the rest wait for a bot's token and a bigger look. */
const MAX_PAGES = 100;

/** Someone signed in to a GitLab (see GitLabSignIns.everyone). */
export interface Signed extends GitLabCreds {
  account: string;
}

interface Saved {
  url: string;
  slots: WorldSlots;
  projects: WorldProject[];
  syncedAt: number;
}

/** A project as GitLab's API lists it, as the world needs it; undefined if it isn't one. */
export function projectOf(p: any): WorldProject | undefined {
  if (!p || typeof p.id !== 'number' || typeof p.path_with_namespace !== 'string') return undefined;
  const namespace = typeof p.namespace?.full_path === 'string' ? p.namespace.full_path : p.path_with_namespace.split('/').slice(0, -1).join('/');
  if (!namespace) return undefined;
  return {
    id: p.id,
    path: p.path_with_namespace,
    name: typeof p.name === 'string' && p.name ? p.name : p.path_with_namespace.split('/').pop()!,
    namespace,
    ...(p.namespace?.kind === 'user' ? { personal: true } : {}),
    archived: p.archived === true,
    webUrl: typeof p.web_url === 'string' ? p.web_url : '',
  };
}

export class GitLabWorld {
  private file: string;
  private saved?: Saved;
  private current?: WorldState;
  private syncing?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private soon?: NodeJS.Timeout;

  constructor(
    dataDir: string,
    /** Everyone signed in to a GitLab, with their tokens. */
    private everyone: () => Signed[],
    /** The world changed. */
    private onChange: (state: WorldState) => void,
    private api: GitLabApi = gitlabApi,
  ) {
    this.file = path.join(dataDir, 'gitlab-world.json');
    this.load();
  }

  /** The world as it stands; undefined while nobody's signed in to a GitLab and it was never looked at. */
  state(): WorldState | undefined {
    return this.current;
  }

  start() {
    void this.sync();
    this.timer = setInterval(() => void this.sync(), SYNC_MS);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    clearTimeout(this.soon);
  }

  /** Someone signed in or out: look again shortly. */
  poke() {
    clearTimeout(this.soon);
    this.soon = setTimeout(() => void this.sync(), SOON_MS);
    this.soon.unref();
  }

  /** Looks at every project the people signed in can see. One at a time: a second ask is the first. */
  sync(): Promise<void> {
    this.syncing ??= this.look().finally(() => (this.syncing = undefined));
    return this.syncing;
  }

  // ---------------------------------------------------------------------------

  /** The GitLab the world is of: the one most people are signed in to (the one it already was, on a tie). */
  private instance(signed: Signed[]): string | undefined {
    const count = new Map<string, number>();
    for (const s of signed) count.set(s.url, (count.get(s.url) ?? 0) + 1);
    let best: string | undefined;
    for (const [url, n] of count) if (!best || n > count.get(best)! || (n === count.get(best) && url === this.saved?.url)) best = url;
    return best;
  }

  private async look() {
    const signed = this.everyone();
    const url = this.instance(signed);
    if (!url) return;
    // Each token once: two accounts can't share one, but the same person may be signed in twice.
    const tokens = [...new Map(signed.filter((s) => s.url === url).map((s) => [s.token, s])).values()];
    const projects = new Map<number, WorldProject>();
    const errors: string[] = [];
    let anyone = false;
    for (const s of tokens) {
      try {
        for (const p of await this.list(s)) projects.set(p.id, p);
        anyone = true;
      } catch (err) {
        errors.push((err as Error).message);
      }
    }
    // Nobody's token worked: keep the world as it was, and say why.
    if (!anyone) {
      if (this.current) this.publish({ ...this.current, error: errors[0] });
      return;
    }
    const all = [...projects.values()].sort((a, b) => a.id - b.id);
    const { districts, slots } = arrange(all, this.saved?.url === url ? this.saved.slots : undefined);
    this.saved = { url, slots: { districts: { ...this.saved?.slots.districts, ...slots.districts }, buildings: { ...this.saved?.slots.buildings, ...slots.buildings } }, projects: all, syncedAt: Date.now() };
    this.save();
    this.publish({ url, districts, projects: all.length, syncedAt: this.saved.syncedAt, ...(errors.length ? { error: errors[0] } : {}) });
  }

  /** Every project `s`'s token can see, oldest first, a page at a time by id (fast however many there are). */
  private async list(s: Signed): Promise<WorldProject[]> {
    const out: WorldProject[] = [];
    let after = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const got = await this.api(s, 'GET', `projects?order_by=id&sort=asc&per_page=${PER_PAGE}&id_after=${after}`);
      const items = Array.isArray(got) ? got : [];
      for (const raw of items) {
        const p = projectOf(raw);
        if (p) out.push(p);
      }
      if (items.length < PER_PAGE) break;
      after = Math.max(after, ...items.map((i: any) => Number(i.id) || 0));
    }
    return out;
  }

  private publish(state: WorldState) {
    this.current = state;
    this.onChange(state);
  }

  private load() {
    try {
      const s = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Saved>;
      if (typeof s.url !== 'string' || !s.slots || !Array.isArray(s.projects)) return;
      this.saved = { url: s.url, slots: { districts: s.slots.districts ?? {}, buildings: s.slots.buildings ?? {} }, projects: s.projects, syncedAt: s.syncedAt ?? 0 };
      // What it was at the last look stands until the next: the city doesn't start empty.
      const { districts } = arrange(this.saved.projects, this.saved.slots);
      this.current = { url: s.url, districts, projects: this.saved.projects.length, syncedAt: this.saved.syncedAt };
    } catch {
      // never looked at
    }
  }

  private save() {
    try {
      writeFileSync(this.file, JSON.stringify(this.saved), { mode: 0o600 });
    } catch (err) {
      console.error(`agent-office: couldn't save ${this.file}: ${(err as Error).message}`);
    }
  }
}
