import type { Net } from '../net';
import { store } from '../state';
import { h, openModal } from './dom';

/** Campus lobby: only server-authorized buildings are ever rendered here. */
export function openBuildings(net: Net) {
  const body = h('div.body');
  const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const dialog = h('div.modal', { role: 'dialog', 'aria-label': 'Buildings', style: 'width:min(560px,100%)' }, h('header', {}, h('h2', {}, '🏢 Campus buildings'), close), body);
  const modal = openModal(dialog);
  close.addEventListener('click', () => modal.close());
  const render = () => {
    body.replaceChildren();
    if (!store.campus.buildings.length) body.append(h('p.empty', {}, 'No buildings are available for this account.'));
    for (const building of store.campus.buildings) {
      const chosen = building.id === store.campus.selected;
      const enter = h('button.btn.primary', { type: 'button', disabled: building.access === 'scanning' }, chosen ? 'Current building' : building.access === 'scanning' ? 'Scanning…' : 'Tap ID card');
      enter.addEventListener('click', () => net.send({ t: 'building.select', buildingId: building.id }));
      body.append(h('section.card', {}, h('h3', {}, building.name), h('p.note', {}, `${building.role} · ${building.access}`), enter));
    }
    if (store.campus.selected && store.campus.members) {
      const accountId = h('input', { type: 'text', placeholder: 'Account ID', maxlength: 32, 'aria-label': 'Account ID to add' }) as HTMLInputElement;
      const add = h('button.btn', { type: 'button' }, 'Add member');
      add.addEventListener('click', () => { if (accountId.value.trim()) net.send({ t: 'building.member.add', buildingId: store.campus.selected!, accountId: accountId.value.trim(), role: 'member' }); });
      const members = h('ul.team-list');
      for (const member of store.campus.members) {
        const role = h('select', { 'aria-label': `Role for ${member.name}` }, ...['admin', 'member', 'visitor'].map((value) => h('option', { value, selected: member.role === value }, value)));
        role.addEventListener('change', () => net.send({ t: 'building.member.role', buildingId: store.campus.selected!, accountId: member.accountId, role: (role as HTMLSelectElement).value as 'admin' | 'member' | 'visitor' }));
        const remove = h('button.btn.danger', { type: 'button' }, 'Remove');
        remove.addEventListener('click', () => net.send({ t: 'building.member.remove', buildingId: store.campus.selected!, accountId: member.accountId }));
        members.append(h('li', {}, h('span.name', {}, member.name), member.role === 'owner' ? h('span.role', {}, 'owner') : role, member.role === 'owner' ? null : remove));
      }
      body.append(h('h3', {}, 'Members'), h('div.invite-row', {}, accountId, add), members);
    }
    if (store.campus.activity?.length) {
      const activity = h('ul.team-list');
      for (const event of store.campus.activity.slice(0, 20)) activity.append(h('li', {}, h('span.name', {}, event.action), h('span.keys', {}, new Date(event.at).toLocaleString())));
      body.append(h('h3', {}, 'Access activity'), activity);
    }
  };
  const off = store.on('campus', render);
  const oldClose = modal.close;
  modal.close = () => { off(); oldClose(); };
  render(); net.send({ t: 'building.get' });
}
