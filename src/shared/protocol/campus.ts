// The campus: a building per account, standing round the city, each with that account's own floors.
// You get into someone else's with your ID card, at the reader by its door, if they invited you.

/** The office's own building: every floor nobody owns (ones from before accounts, the office's own checkout). */
export const MAIN_BUILDING = 'main';

/** One of the buildings on the campus, as you see it. */
export interface BuildingInfo {
  /** The owner's account id, or MAIN_BUILDING. */
  id: string;
  /** Whose it is: the owner's name, or the office's. */
  name: string;
  /** How many floors it has (it's as tall as that, at least one storey). */
  floors: number;
  /** Your card opens its door: it's yours, you're on its guest list, you're an admin, or it's the office's own. */
  access: boolean;
  /** It's yours. */
  mine: boolean;
}

/** Someone who can be invited into your building. */
export interface CampusPerson {
  id: string;
  name: string;
}

export interface CampusState {
  /** Every building, in the order they stand round the city (see shared/campus.ts). */
  buildings: BuildingInfo[];
  /** The one you're in (or under, on its street): it's the one in the middle of the map. */
  here: string;
  /** Your building's guest list, and who else there is to put on it; only when you have a building. */
  guests?: CampusPerson[];
  people?: CampusPerson[];
}

export type CampusClientMsg =
  /** Your card, at the reader by `building`'s door: in to its bottom floor, if it opens. */
  | { t: 'campus.tap'; building: string }
  /** Onto your building's guest list, or off it. */
  | { t: 'campus.invite'; account: string }
  | { t: 'campus.uninvite'; account: string };

export type CampusServerMsg =
  | { t: 'campus'; state: CampusState }
  /** What the reader said: green (`ok`) and in you go, through the door onto `floor` (its bottom one), or red and why not. */
  | { t: 'campus.tapped'; building: string; ok: boolean; text: string; floor?: string };
