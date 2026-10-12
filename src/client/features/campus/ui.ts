import type { Net } from '../../net';
import { store } from '../../state';
import { h, openModal } from '../../ui/dom';

/** Your building's guest list: whose ID card opens its door, and who else there is to add. */
export function openGuestList(net: Net) {
  const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const body = h('div.body');
  const el = h(
    'div.modal.jukebox',
    { role: 'dialog', 'aria-label': 'Guest list' },
    h('header', {}, h('h2', {}, '🪪 Your building’s guest list'), close),
    body,
    h('footer', {}, h('span.grow', {}, 'Guests’ cards open your building’s door, and its floors are theirs to visit and work on. Admins can always get in.')),
  );
  const row = (name: string, label: string, title: string, send: () => void) => {
    const btn = h('button.btn', { title }, label);
    btn.addEventListener('click', send);
    return h('li', {}, h('div.svc-main', {}, h('div.svc-title', {}, name)), btn);
  };
  const render = () => {
    const { guests = [], people = [] } = store.campus;
    body.replaceChildren(
      h('h3', {}, 'Guests'),
      guests.length
        ? h('ul.svc-list', {}, ...guests.map((g) => row(g.name, 'Remove', `Take ${g.name} off your guest list`, () => net.send({ t: 'campus.uninvite', account: g.id }))))
        : h('p.setting-note', {}, 'Nobody yet: only you (and the admins) can get in.'),
      h('h3', {}, 'Everyone else'),
      people.length
        ? h('ul.svc-list', {}, ...people.map((p) => row(p.name, 'Invite', `Let ${p.name}’s card open your building’s door`, () => net.send({ t: 'campus.invite', account: p.id }))))
        : h('p.setting-note', {}, 'Nobody else has an account yet.'),
    );
  };
  render();
  const off = store.on('campus', render);
  const modal = openModal(el, { onClose: () => off() });
  close.addEventListener('click', () => modal.close());
}
