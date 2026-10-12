import type { GitLabApi, GitLabCreds } from './gitlab-boards.js';
import { gitlabApi } from './gitlab-boards.js';

/*
 * Who may do what on the GitLab world's floors (see gitlab-world.ts): each person's own GitLab
 * membership. GitLab lists the projects someone is a member of with their role in each (their own,
 * or one they have through a group), which the office asks with their own token and keeps for a few
 * minutes. Going onto a floor takes a role in its project (Guest and up); hiring workers there takes
 * Developer and up. On the shared password, with no account, it's the office's own floor: anyone in.
 */

/** GitLab's roles, by their access levels. */
export const ROLE = { guest: 10, reporter: 20, developer: 30, maintainer: 40, owner: 50 } as const;

const FRESH_MS = 5 * 60_000;
const PER_PAGE = 100;
const MAX_PAGES = 100;

interface Known {
  at: number;
  /** By project id: their role in it. */
  levels: Map<number, number>;
  looking?: Promise<void>;
}

export class GitLabAccess {
  private known = new Map<string, Known>();
  /** A GitLab floor's project id (from the floor, or from the world by its page). */
  projectOf?: (floor: { gitlab?: string; gitlabProjectId?: number }) => number | undefined;

  constructor(
    /** The GitLab `account` is signed in to, and its token. */
    private creds: (account: string) => GitLabCreds | undefined,
    /** `account`'s roles changed (to tell their browsers). */
    private onChange: (account: string) => void,
    private api: GitLabApi = gitlabApi,
  ) {}

  /**
   * `account`'s role in project `id` as last known (0: none), looking again in the background when
   * that's a while ago. Undefined: never looked yet (call `refresh` and wait).
   */
  level(account: string, id: number): number | undefined {
    const k = this.known.get(account);
    if (!k) {
      void this.refresh(account);
      return undefined;
    }
    if (Date.now() - k.at > FRESH_MS) void this.refresh(account);
    return k.levels.get(id) ?? 0;
  }

  /**
   * Why `who` may not set workers going on `floor` (hire one, queue a task, call a meeting), if they
   * may not: on a GitLab project's floor that takes Developer or up. Anyone may on the office's own.
   */
  mayWork(who: { accountId?: string }, floor: { gitlab?: string; gitlabProjectId?: number }): string | undefined {
    if (!floor.gitlab || !who.accountId) return undefined;
    const id = this.projectOf?.(floor);
    const level = id === undefined ? 0 : (this.level(who.accountId, id) ?? 0);
    if (level >= ROLE.developer) return undefined;
    return `You're ${level ? `a ${roleName(level)}` : 'not a member'} on this GitLab project: setting workers going here takes Developer or up`;
  }

  /** Every role `account` has, by project id (empty before the first look). */
  levels(account: string): Record<number, number> {
    return Object.fromEntries(this.known.get(account)?.levels ?? []);
  }

  /** Looks at `account`'s memberships now (one look at a time). */
  refresh(account: string): Promise<void> {
    const k = this.known.get(account);
    if (k?.looking) return k.looking;
    const c = this.creds(account);
    if (!c) {
      this.known.set(account, { at: Date.now(), levels: new Map() });
      return Promise.resolve();
    }
    const entry: Known = k ?? { at: 0, levels: new Map() };
    entry.looking = this.list(c)
      .then((levels) => {
        entry.levels = levels;
        entry.at = Date.now();
        this.onChange(account);
      })
      .catch((err) => console.warn(`agent-office: couldn't look at ${account}'s GitLab access: ${(err as Error).message}`))
      .finally(() => (entry.looking = undefined));
    this.known.set(account, entry);
    return entry.looking;
  }

  /** Forgets `account`'s roles (they signed out of GitLab, or in as someone else). */
  forget(account: string) {
    this.known.delete(account);
    this.onChange(account);
  }

  /** Every project `c`'s user is a member of, with their role (the higher of the project's and its group's). */
  private async list(c: GitLabCreds): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    let after = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const got = await this.api(c, 'GET', `projects?membership=true&order_by=id&sort=asc&per_page=${PER_PAGE}&id_after=${after}`);
      const items: any[] = Array.isArray(got) ? got : [];
      for (const p of items) {
        if (typeof p?.id !== 'number') continue;
        const level = Math.max(Number(p.permissions?.project_access?.access_level) || 0, Number(p.permissions?.group_access?.access_level) || 0);
        // A member whose role GitLab didn't say (an older one): at least a Guest.
        out.set(p.id, level || ROLE.guest);
      }
      if (items.length < PER_PAGE) break;
      after = Math.max(after, ...items.map((i) => Number(i.id) || 0));
    }
    return out;
  }
}

/** What a role's called. */
export function roleName(level: number): string {
  return level >= ROLE.owner ? 'Owner' : level >= ROLE.maintainer ? 'Maintainer' : level >= ROLE.developer ? 'Developer' : level >= ROLE.reporter ? 'Reporter' : level >= ROLE.guest ? 'Guest' : 'No access';
}
