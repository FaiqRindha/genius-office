import './ui.css';
import type { WorldBuilding } from '../../../shared/gitlab-world';
import type { Net } from '../../net';
import { store } from '../../state';
import { h, openModal } from '../../ui/dom';

// A building of the GitLab Quarter's door: its floors, one a project, each with your role in it (from
// your own GitLab membership) or a 🔒 where you're not a member. Pick one and you go up to it; one
// nobody's opened yet is cloned first, with your own GitLab sign-in.

const ROLES: [number, string][] = [
  [50, 'Owner'],
  [40, 'Maintainer'],
  [30, 'Developer'],
  [20, 'Reporter'],
  [10, 'Guest'],
];

/** What your role in a project is called; undefined when you're not a member. */
export function roleOf(level: number | undefined): string | undefined {
  return ROLES.find(([at]) => (level ?? 0) >= at)?.[1];
}

/** Opens `b`'s door: `ride` takes you to the floor you pick. */
export function openBuildingDoor(net: Net, b: WorldBuilding, ride: (floor: string) => void) {
  let going: number | null = null;
  let error = '';
  const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const list = h('div.gl-floors');
  const status = h('div');
  const el = h(
    'div.modal.gl-door',
    { role: 'dialog', 'aria-label': b.name },
    h('header', {}, h('h2', {}, `🦊 ${b.name}`), close),
    h('div.body', {}, h('p.note', {}, `${b.key} · its floors are its projects. You go onto the ones you're a member of on GitLab; Developer and up can set workers going there.`), list, status),
  );

  const render = () => {
    const levels = store.gitlabAccess;
    // Top floor first, the way an elevator's buttons stack.
    const rows = [...b.floors].sort((x, y) => y.level - x.level).map((f) => {
      const level = levels?.[f.projectId];
      const role = roleOf(level);
      const locked = !!levels && !role;
      // Its own storey for good (see WorldFloor.level).
      const n = f.level + 1;
      const btn = h(
        'button.gl-floor',
        { type: 'button', class: locked ? 'locked' : '', disabled: locked || going !== null, title: locked ? `You're not a member of ${f.path} on GitLab` : `Go up to ${f.path}` },
        h('span.gl-no', {}, locked ? '🔒' : String(n)),
        h('span.gl-text', {}, h('span.gl-name', {}, f.name, f.archived ? h('span.gl-tag', {}, '📦 archived') : null), h('span.gl-path', {}, f.path)),
        h('span.gl-role', { class: role ? (level! >= 30 ? 'dev' : 'read') : 'none' }, going === f.projectId ? '⏳' : (role ?? (levels ? 'no access' : '…'))),
      );
      btn.addEventListener('click', () => {
        if (locked || going !== null) return;
        going = f.projectId;
        error = '';
        store.gitlabEntered = null;
        net.send({ t: 'gitlab.enter', projectId: f.projectId });
        render();
      });
      return btn;
    });
    list.replaceChildren(...rows);
    status.replaceChildren(
      ...(going !== null ? [h('p.note.busy', {}, '⏳ Going up… a project nobody has opened yet is cloned first, which can take a minute.')] : []),
      ...(error ? [h('p.err', {}, error)] : []),
      ...(!levels ? [h('p.note', {}, 'Asking GitLab which of these you’re a member of…')] : []),
    );
  };

  const onEntered = () => {
    const m = store.gitlabEntered;
    if (!m || m.projectId !== going) return;
    going = null;
    if (m.floor) {
      modal.close();
      ride(m.floor);
      return;
    }
    error = m.error ?? "Couldn't go up there";
    render();
  };
  const offs = [store.on('gitlabAccess', render), store.on('gitlabEntered', onEntered)];
  const modal = openModal(el, { onClose: () => offs.forEach((off) => off()) });
  close.addEventListener('click', () => modal.close());
  net.send({ t: 'gitlab.access' });
  render();
}
