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
 */

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

  constructor(
    dataDir: string,
    private accounts: Accounts,
    /** What the office's own building is called. */
    private officeName: string,
  ) {
    this.file = path.join(dataDir, 'campus.json');
    this.load();
  }

  /** The building a floor is in: its owner's, while that account is there, else the office's own. */
  of(def: { owner?: string }): string {
    return def.owner && this.accounts.get(def.owner) ? def.owner : MAIN_BUILDING;
  }

  /** Whether `who`'s card opens `building`'s door. */
  mayEnter(who: Who, building: string): boolean {
    if (building === MAIN_BUILDING || who.admin || !who.accountId) return true;
    return building === who.accountId || (this.guests[building] ?? []).includes(who.accountId);
  }

  /** Remembers that connection `id` was last in `building`. */
  place(id: string, building: string) {
    this.last.set(id, building);
  }

  forget(id: string) {
    this.last.delete(id);
  }

  /** The building connection `id` is in: its floor's, else the last one it was in, else its own (or the office's). */
  here(id: string, who: Who, floor: { owner?: string } | undefined): string {
    if (floor) {
      const b = this.of(floor);
      this.last.set(id, b);
      return b;
    }
    return this.last.get(id) ?? (who.accountId && this.accounts.get(who.accountId) ? who.accountId : MAIN_BUILDING);
  }

  /** Every building, in the order they stand (see buildingAt): the office's own on the main street, then each account's, oldest first. */
  ids(): string[] {
    return [MAIN_BUILDING, ...this.accounts.list().map((a) => a.id)];
  }

  /** What `who`, in `here`, sees of the campus: `defs` are every floor (on its way too), `open` the ones open, bottom one first. */
  state(who: Who, here: string, defs: readonly { owner?: string }[], open: readonly { id: string; owner?: string }[] = []): CampusState {
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
