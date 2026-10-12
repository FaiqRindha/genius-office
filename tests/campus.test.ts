import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Accounts } from '../src/server/accounts.js';
import { Campus } from '../src/server/campus.js';
import { DISTRICT, DOOR, FOOTPRINT, READER, buildingAt, isOutdoors, slotAt } from '../src/shared/campus.js';
import { EXIT_STAIRS, FLOOR, STREET_Y } from '../src/shared/layout.js';
import { MAIN_BUILDING } from '../src/shared/protocol.js';

/** An office's data folder with these accounts in it (no passwords that work: these tests never sign in). */
function office(...people: [id: string, name: string, role?: 'admin' | 'member'][]) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ao-campus-'));
  const accounts = people.map(([id, name, role], i) => ({ id, name, role: role ?? 'member', hash: '00', salt: '00', createdAt: i, createdBy: 'test' }));
  writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({ accounts, invites: [] }));
  const a = new Accounts(dir);
  return { dir, accounts: a, campus: new Campus(dir, a, 'the office') };
}

const ada = { accountId: 'ada000', admin: false };
const bob = { accountId: 'bob000', admin: false };

test('a floor is in its owner’s building while they have an account, else in the office’s own', () => {
  const { campus } = office(['ada000', 'Ada']);
  assert.equal(campus.of({ owner: 'ada000' }), 'ada000');
  assert.equal(campus.of({}), MAIN_BUILDING);
  assert.equal(campus.of({ owner: 'gone00' }), MAIN_BUILDING);
});

test('your card opens your own building, the office’s, and anyone’s whose guest list you’re on', () => {
  const { campus } = office(['ada000', 'Ada'], ['bob000', 'Bob'], ['cy0000', 'Cy', 'admin']);
  assert.ok(campus.mayEnter(ada, 'ada000'));
  assert.ok(campus.mayEnter(ada, MAIN_BUILDING));
  assert.ok(!campus.mayEnter(bob, 'ada000'));
  // Admins, and the shared password (whoever's on it is one), get in anywhere.
  assert.ok(campus.mayEnter({ accountId: 'cy0000', admin: true }, 'ada000'));
  assert.ok(campus.mayEnter({ admin: true }, 'ada000'));

  assert.deepEqual(campus.invite('ada000', 'bob000'), { name: 'Bob' });
  assert.ok(campus.mayEnter(bob, 'ada000'));
  assert.equal(campus.invite('ada000', 'bob000'), 'Bob is already on your guest list');
  assert.equal(campus.invite('ada000', 'ada000'), "It's your own building: your card already opens it");
  assert.equal(campus.invite('ada000', 'nobody'), 'There is no such account');
  assert.deepEqual(campus.uninvite('ada000', 'bob000'), { name: 'Bob' });
  assert.ok(!campus.mayEnter(bob, 'ada000'));
  assert.equal(campus.uninvite('ada000', 'bob000'), "They're not on your guest list");
});

test('the guest lists are kept across a restart', () => {
  const { dir, accounts, campus } = office(['ada000', 'Ada'], ['bob000', 'Bob']);
  campus.invite('ada000', 'bob000');
  const again = new Campus(dir, accounts, 'the office');
  assert.ok(again.mayEnter(bob, 'ada000'));
  assert.deepEqual(again.guestsOf('ada000'), [{ id: 'bob000', name: 'Bob' }]);
});

test('what you see of the campus: every building where it stands, which open to you, their bottom floors, and your guest list', () => {
  const { campus } = office(['ada000', 'Ada'], ['bob000', 'Bob']);
  const defs = [{ owner: 'ada000' }, { owner: 'ada000' }, {}];
  const open = [
    { id: 'ada-api', owner: 'ada000' },
    { id: 'lobby', owner: undefined },
    { id: 'ada-web', owner: 'ada000' },
  ];
  const s = campus.state(bob, 'bob000', defs, open);
  assert.deepEqual(
    s.buildings.map((b) => [b.id, b.name, b.floors, b.access, b.mine, b.bottom]),
    [
      [MAIN_BUILDING, 'the office', 1, true, false, 'lobby'],
      ['ada000', 'Ada', 2, false, false, undefined],
      ['bob000', 'Bob', 0, true, true, undefined],
    ],
  );
  // Which building each open floor is in, and how far up it.
  assert.deepEqual(s.floors, { 'ada-api': ['ada000', 0], lobby: [MAIN_BUILDING, 0], 'ada-web': ['ada000', 1] });
  assert.equal(s.here, 'bob000');
  assert.deepEqual(s.guests, []);
  assert.deepEqual(s.people, [{ id: 'ada000', name: 'Ada' }]);
  // The office's own building is always first, on the main street.
  assert.deepEqual(campus.ids(), [MAIN_BUILDING, 'ada000', 'bob000']);
  // A guest sees the bottom floor its door opens onto.
  campus.invite('ada000', 'bob000');
  assert.equal(campus.state(bob, 'bob000', defs, open).buildings[1].bottom, 'ada-api');
  // The shared password has no building, so no guest list.
  assert.equal(campus.state({ admin: true }, MAIN_BUILDING, defs).guests, undefined);
});

test('where you are on the campus: your floor’s building, else the last one you were in, else your own', () => {
  const { campus } = office(['ada000', 'Ada']);
  assert.equal(campus.here('c1', ada, undefined), 'ada000');
  assert.equal(campus.here('c1', ada, {}), MAIN_BUILDING);
  assert.equal(campus.here('c1', ada, undefined), MAIN_BUILDING);
  campus.forget('c1');
  assert.equal(campus.here('c1', ada, undefined), 'ada000');
  assert.equal(campus.here('c2', { admin: true }, undefined), MAIN_BUILDING);
});

test('every building stands where the campus has it: the office’s on the main street, the rest five to a row, clear of each other', () => {
  assert.deepEqual(buildingAt(0), { x: 0, z: 0 });
  assert.deepEqual(buildingAt(1), slotAt(0));
  assert.deepEqual(slotAt(0), { x: -2 * DISTRICT.pitchX, z: DISTRICT.firstZ });
  assert.deepEqual(slotAt(5), { x: -2 * DISTRICT.pitchX, z: DISTRICT.firstZ - DISTRICT.pitchZ });
  const at = Array.from({ length: 21 }, (_, i) => buildingAt(i));
  // Room for each one's steps and reader on its west side, too.
  const width = FOOTPRINT.maxX - FOOTPRINT.minX + 4;
  const depth = FOOTPRINT.maxZ - FOOTPRINT.minZ;
  for (let i = 0; i < at.length; i++) {
    for (let j = i + 1; j < at.length; j++) assert.ok(Math.abs(at[i].x - at[j].x) > width + 10 || Math.abs(at[i].z - at[j].z) > depth + 10, `buildings ${i} and ${j} overlap`);
  }
  // The district is north of the office's neighbours (at z -50 and up); its readers are out on the street, by the steps.
  assert.ok(at.slice(1).every((s) => s.z + FOOTPRINT.maxZ < -60));
  assert.ok(READER.x < FOOTPRINT.minX && READER.z > EXIT_STAIRS.landingZ1);
  // Its door is in its west wall, on the landing at the top of the steps.
  assert.ok(DOOR.x < FLOOR.minX && DOOR.x > FOOTPRINT.minX - 0.01);
});

test('out on the grounds is the street, the steps and the district; in the room (or the back office) is indoors', () => {
  assert.equal(isOutdoors(0, 0, 0), false);
  assert.equal(isOutdoors(15, 0, -20), false, 'the back office');
  assert.equal(isOutdoors(0, STREET_Y, 0), true, 'the garage under it');
  assert.equal(isOutdoors(-19, 0, 6.5), true, 'the landing outside the exit door');
  assert.equal(isOutdoors(0, STREET_Y, 27), true, 'the street');
  assert.equal(isOutdoors(0, 0, 16), true, 'the balcony');
});
