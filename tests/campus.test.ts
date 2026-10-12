import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Accounts } from '../src/server/accounts.js';
import { Campus } from '../src/server/campus.js';
import { DISTRICT, FOOTPRINT, READER, slotAt } from '../src/shared/campus.js';
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

test('what you see of the campus: every building in its slot, which open to you, and your guest list', () => {
  const { campus } = office(['ada000', 'Ada'], ['bob000', 'Bob']);
  const defs = [{ owner: 'ada000' }, { owner: 'ada000' }, {}];
  const s = campus.state(bob, 'bob000', defs);
  assert.deepEqual(
    s.buildings.map((b) => [b.id, b.name, b.floors, b.access, b.mine]),
    [
      [MAIN_BUILDING, 'the office', 1, true, false],
      ['ada000', 'Ada', 2, false, false],
      ['bob000', 'Bob', 0, true, true],
    ],
  );
  assert.equal(s.here, 'bob000');
  assert.deepEqual(s.guests, []);
  assert.deepEqual(s.people, [{ id: 'ada000', name: 'Ada' }]);
  // With no floors of its own, the office's building isn't put up once there are accounts.
  assert.deepEqual(campus.ids([{ owner: 'ada000' }]), ['ada000', 'bob000']);
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

test('the district’s slots are five to a row, clear of each other, and its readers stand outside the buildings', () => {
  const at = Array.from({ length: 20 }, (_, i) => slotAt(i));
  assert.deepEqual(at[0], { x: -2 * DISTRICT.pitchX, z: DISTRICT.firstZ });
  assert.deepEqual(at[5], { x: -2 * DISTRICT.pitchX, z: DISTRICT.firstZ - DISTRICT.pitchZ });
  const width = FOOTPRINT.maxX - FOOTPRINT.minX;
  const depth = FOOTPRINT.maxZ - FOOTPRINT.minZ;
  for (let i = 0; i < at.length; i++) {
    for (let j = i + 1; j < at.length; j++) assert.ok(Math.abs(at[i].x - at[j].x) > width + 10 || Math.abs(at[i].z - at[j].z) > depth + 10, `slots ${i} and ${j} overlap`);
  }
  // In front of the doors, off the building's footprint.
  assert.ok(READER.z > FOOTPRINT.maxZ && READER.x > FOOTPRINT.minX && READER.x < FOOTPRINT.maxX);
  // The whole district is north of the office's neighbours (at z -50 and up).
  assert.ok(at.every((s) => s.z + FOOTPRINT.maxZ < -60));
});
