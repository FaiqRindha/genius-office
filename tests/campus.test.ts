import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Accounts } from '../src/server/accounts.js';
import { Campus, GITLAB_BUILDING } from '../src/server/campus.js';
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

test('every floor is the office’s own, but a GitLab project’s, which is in its namespace’s building', () => {
  const { campus } = office(['ada000', 'Ada']);
  // Accounts have no buildings of their own any more (see campus.ts): the GitLab Quarter is where projects stand.
  assert.equal(campus.of({ owner: 'ada000' }), MAIN_BUILDING);
  assert.equal(campus.of({}), MAIN_BUILDING);
  assert.equal(campus.of({ gitlab: 'https://gl.example/genius/genius-lab/skynet' }), `${GITLAB_BUILDING}genius/genius-lab`);
  assert.equal(campus.of({ gitlab: 'https://gl.example/qa/afulabot' }), `${GITLAB_BUILDING}qa`);
});

test('a GitLab building’s door is open, and each of its floors is up to the floor gate', () => {
  const { campus } = office(['ada000', 'Ada'], ['bob000', 'Bob']);
  const skynet = { gitlab: 'https://gl.example/genius/genius-lab/skynet', gitlabProjectId: 7 };
  assert.ok(campus.mayEnter(bob, campus.of(skynet)));
  // No gate: anyone in. A gate (their GitLab access): only who it lets.
  assert.ok(campus.mayEnterFloor(bob, skynet));
  campus.floorGate = (who, floor) => !floor.gitlab || who.accountId === 'ada000';
  assert.ok(campus.mayEnterFloor(ada, skynet));
  assert.ok(!campus.mayEnterFloor(bob, skynet));
  // The office's own floors aren't the gate's to keep.
  assert.ok(campus.mayEnterFloor(bob, {}));
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

test('what you see of the campus: the office’s own building, and where each open floor is up it', () => {
  const { campus } = office(['ada000', 'Ada'], ['bob000', 'Bob']);
  const defs = [{ owner: 'ada000' }, {}, { gitlab: 'https://gl.example/g/sub/app' }];
  const open = [
    { id: 'ada-api', owner: 'ada000' },
    { id: 'lobby', owner: undefined },
    { id: 'app', gitlab: 'https://gl.example/g/sub/app' },
  ];
  const s = campus.state(bob, MAIN_BUILDING, defs, open);
  assert.deepEqual(
    s.buildings.map((b) => [b.id, b.name, b.floors, b.access, b.mine, b.bottom]),
    [[MAIN_BUILDING, 'the office', 2, true, false, 'ada-api']],
  );
  // A GitLab project's floor is the first of its own building.
  assert.deepEqual(s.floors, { 'ada-api': [MAIN_BUILDING, 0], lobby: [MAIN_BUILDING, 1], app: [`${GITLAB_BUILDING}g/sub`, 0] });
  assert.deepEqual(campus.ids(), [MAIN_BUILDING]);
  // On a GitLab floor, the world round you is drawn where the office's is.
  assert.equal(campus.state(bob, `${GITLAB_BUILDING}g/sub`, defs, open).here, MAIN_BUILDING);
});

test('where you are on the campus: your floor’s building, else the last one you were in, else the office’s', () => {
  const { campus } = office(['ada000', 'Ada']);
  assert.equal(campus.here('c1', ada, undefined), MAIN_BUILDING);
  assert.equal(campus.here('c1', ada, { gitlab: 'https://gl.example/g/app' }), `${GITLAB_BUILDING}g`);
  assert.equal(campus.here('c1', ada, undefined), `${GITLAB_BUILDING}g`);
  campus.forget('c1');
  assert.equal(campus.here('c1', ada, undefined), MAIN_BUILDING);
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
