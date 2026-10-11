import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BuildingAccess } from '../src/server/building-access.js';
import { BuildingDirectory } from '../src/server/building-directory.js';

test('server guard distinguishes locked, denied, member and visitor access', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'campus-access-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const directory = new BuildingDirectory(dir), building = directory.ensurePrivate('owner', 'Owner'), access = new BuildingAccess(directory);
  assert.match(access.enter(building.id, undefined) ?? '', /named Office account/);
  assert.match(access.enter(building.id, 'outsider') ?? '', /do not have access/);
  assert.equal(directory.addMember(building.id, 'owner', 'visitor', 'visitor'), undefined);
  assert.equal(access.enter(building.id, 'visitor'), undefined);
  assert.equal(access.mutate(building.id, 'visitor'), 'Visitor access is read-only');
  assert.equal(directory.addMember(building.id, 'owner', 'member', 'member'), undefined);
  assert.equal(access.mutate(building.id, 'member'), undefined);
  assert.equal(access.ownsFloor(building.id, { id: 'mine', name: 'mine', dir, palette: 0, addedBy: 'owner', addedAt: 1, buildingId: building.id }), true);
  assert.equal(access.ownsFloor(building.id, { id: 'other', name: 'other', dir, palette: 0, addedBy: 'owner', addedAt: 1, buildingId: 'other-building' }), false);
});
