import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Accounts } from './accounts.js';
import { MAIN_BUILDING, type BuildingInfo, type CampusPerson, type CampusState } from '../shared/protocol.js';

/*
 * The campus
 * ----------
 * In an office with accounts, everyone has a building of their own: the floors they added (see
 * FloorDef.owner), standing round the city. Floors nobody owns (the office's own checkout, ones from
 * before accounts, ones added on the shared password) are the office's own building, which everyone
 * may go into. Anyone else's opens to your ID card only if you're its owner, on its guest list, or an
 * admin. Guest lists are kept in <office>/.agent-office/campus.json.
 *
 * Which building someone is in is the one their floor is in; up on the roof or out in a lobby, it's the
 * last one they were in (see `place`).
 *
 * With the GitLab world (see gitlab-world.ts), accounts no longer have buildings of their own: every
 * floor is the office's own, but a floor that's a GitLab project, which is in its namespace's building
 * in the GitLab Quarter ("gitlab:<group/subgroup>"). Who may go into one of those is up to their own
 * GitLab access, floor by floor (see floorGate and mayEnterFloor).
 */

/** The building of a floor that's a GitLab project: its namespace's, in the GitLab Quarter. */
export const GITLAB_BUILDING = 'gitlab:';

/** A floor as the campus sees it. */
export interface CampusFloor {
  owner?: string;
  /** Its GitLab project's page and id (see FloorDef.gitlab). */
  gitlab?: string;
  gitlabProjectId?: number;
}

/** Who's asking: a connection's account, and whether it's an admin (the shared password is one). */
export interface Who {
  accountId?: string;
  admin: boolean;
}

/** A guest list is at most this long. */
const MAX_GUESTS = 64;

export class Campus {
  private guests: Record<string, string[]> = {};
  private file: string;
  /** The building each connection was last in, for when they're on the roof or in a lobby. */
  private last = new Map<string, string>();
  /** Whether `who` may go onto a floor, beyond its building's door (their GitLab access: see gitlab-access.ts). */
  floorGate?: (who: Who, floor: CampusFloor) => boolean;

  constructor(
    dataDir: string,
    private accounts: Accounts,
    /** What the office's own building is called. */
    private officeName: string,
  ) {
    this.file = path.join(dataDir, 'campus.json');
    this.load();
  }

  /** The building a floor is in: a GitLab project's namespace's, else the office's own. */
  of(def: CampusFloor): string {
    if (def.gitlab) {
      try {
        return GITLAB_BUILDING + new URL(def.gitlab).pathname.split('/').filter(Boolean).slice(0, -1).join('/');
      } catch {
        // not a page: the office's own
      }
    }
    return MAIN_BUILDING;
  }

  /** Whether `who`'s card opens `building`'s door. A GitLab building's is open: its floors are each their own (see mayEnterFloor). */
  mayEnter(who: Who, building: string): boolean {
    if (building === MAIN_BUILDING || building.startsWith(GITLAB_BUILDING) || who.admin || !who.accountId) return true;
    return building === who.accountId || (this.guests[building] ?? []).includes(who.accountId);
  }

  /** Whether `who` may go onto `floor`: its building's door, and the floor's own gate (a GitLab project's access). */
  mayEnterFloor(who: Who, floor: CampusFloor): boolean {
    return this.mayEnter(who, this.of(floor)) && (this.floorGate?.(who, floor) ?? true);
  }

  /** Remembers that connection `id` was last in `building`. */
  place(id: string, building: string) {
    this.last.set(id, building);
  }

  forget(id: string) {
    this.last.delete(id);
  }

  /** The building connection `id` is in: its floor's, else the last one it was in, else its own (or the office's). */
  here(id: string, _who: Who, floor: CampusFloor | undefined): string {
    if (floor) {
      const b = this.of(floor);
      this.last.set(id, b);
      return b;
    }
    return this.last.get(id) ?? MAIN_BUILDING;
  }

  /** Every building that stands round the main street: the office's own (accounts have none now, see above). */
  ids(): string[] {
    return [MAIN_BUILDING];
  }

  /** What `who`, in `here`, sees of the campus: `defs` are every floor (on its way too), `open` the ones open, bottom one first. */
  state(who: Who, here: string, defs: readonly CampusFloor[], open: readonly ({ id: string } & CampusFloor)[] = []): CampusState {
    const floors: CampusState['floors'] = {};
    const up = new Map<string, number>();
    for (const f of open) {
      const b = this.of(f);
      const i = up.get(b) ?? 0;
      floors[f.id] = [b, i];
      up.set(b, i + 1);
    }
    const buildings: BuildingInfo[] = this.ids().map((id) => {
      const access = this.mayEnter(who, id);
      const bottom = access ? open.find((f) => this.of(f) === id)?.id : undefined;
      return {
        id,
        name: id === MAIN_BUILDING ? this.officeName : (this.accounts.get(id)?.name ?? '?'),
        floors: defs.filter((d) => this.of(d) === id).length,
        access,
        mine: id === who.accountId,
        ...(bottom ? { bottom } : {}),
      };
    });
    // A GitLab building's floors are built where the office's are (the Quarter's buildings are drawn
    // on their own, see gitlab-world), so for the world round you, you're at the office's.
    if (here.startsWith(GITLAB_BUILDING)) here = MAIN_BUILDING;
    const own = who.accountId && this.accounts.get(who.accountId) ? who.accountId : undefined;
    if (!own) return { buildings, here, floors };
    const guests = this.guestsOf(own);
    const people: CampusPerson[] = this.accounts
      .list()
      .filter((a) => a.id !== own && !guests.some((g) => g.id === a.id))
      .map((a) => ({ id: a.id, name: a.name }));
    return { buildings, here, floors, guests, people };
  }

  /** Who's on `owner`'s guest list, as long as their accounts are still there. */
  guestsOf(owner: string): CampusPerson[] {
    return (this.guests[owner] ?? []).flatMap((id) => {
      const a = this.accounts.get(id);
      return a ? [{ id: a.id, name: a.name }] : [];
    });
  }

  /** Puts `guest` on `owner`'s guest list; the guest's name, or why not. */
  invite(owner: string, guest: string): { name: string } | string {
    if (!this.accounts.get(owner)) return 'Only people with an account have a building to invite anyone into';
    const a = this.accounts.get(guest);
    if (!a) return 'There is no such account';
    if (a.id === owner) return "It's your own building: your card already opens it";
    const list = (this.guests[owner] ?? []).filter((id) => this.accounts.get(id));
    if (list.includes(a.id)) return `${a.name} is already on your guest list`;
    if (list.length >= MAX_GUESTS) return `Your guest list is full (${MAX_GUESTS} people)`;
    this.guests[owner] = [...list, a.id];
    this.save();
    return { name: a.name };
  }

  /** Takes `guest` off `owner`'s guest list; their name, or why not. */
  uninvite(owner: string, guest: string): { name: string } | string {
    const list = this.guests[owner] ?? [];
    if (!list.includes(guest)) return "They're not on your guest list";
    this.guests[owner] = list.filter((id) => id !== guest);
    if (!this.guests[owner].length) delete this.guests[owner];
    this.save();
    return { name: this.accounts.get(guest)?.name ?? 'They' };
  }

  private load() {
    if (!existsSync(this.file)) return;
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as { guests?: unknown };
      const g = saved.guests;
      if (!g || typeof g !== 'object') return;
      for (const [owner, ids] of Object.entries(g as Record<string, unknown>)) {
        if (Array.isArray(ids)) this.guests[owner] = ids.filter((id): id is string => typeof id === 'string').slice(0, MAX_GUESTS);
      }
    } catch (err) {
      console.error(`agent-office: ${this.file} couldn't be read, so every guest list starts empty: ${(err as Error).message}`);
    }
  }

  private save() {
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ guests: this.guests }, null, 2));
      renameSync(tmp, this.file);
    } catch (err) {
      console.error(`agent-office: couldn't save the guest lists: ${(err as Error).message}`);
    }
  }
}
