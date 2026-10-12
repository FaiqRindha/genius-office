import './gitlab.css';
import type { Net } from '../net';
import { store } from '../state';
import { h } from './dom';
import { confirmDialog } from './prompt';

/**
 * 🦊 GitLab, in 🔐 Your sign-ins: the self-hosted GitLab your workers push to and open merge
 * requests on as you (see server/gitlab.ts). Its address and a personal access token; the office
 * checks the token with GitLab before it keeps it. Returns the card and how to let go of it.
 */
export function gitlabCard(net: Net): { el: HTMLElement; dispose(): void } {
  const el = h('section.signin');
  // Kept across renders, so what's half typed survives the next update.
  const url = h('input', { type: 'text', inputmode: 'url', placeholder: 'https://gitlab.example.com', 'aria-label': 'Your GitLab’s address', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
  const token = h('input', { type: 'password', placeholder: 'glpat-…', 'aria-label': 'GitLab token', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
  const form = h('form.signin-gitlab', {}, url, h('div.invite-row', {}, token, h('button.btn.primary', { type: 'submit' }, 'Save'))) as HTMLFormElement;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!url.value.trim()) return url.focus();
    if (!token.value.trim()) return token.focus();
    net.send({ t: 'gitlab.token', url: url.value.trim(), token: token.value.trim() });
    token.value = '';
  });

  const render = () => {
    const s = store.gitlab;
    if (!store.me.account || !s) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.className = `signin ${s.status}`;
    if (s.url && !url.value) url.value = s.url;
    const status =
      s.status === 'ok'
        ? h('span.signin-who.ok', {}, '✅ ', `${s.who ?? 'Signed in'} on ${host(s.url)}`)
        : s.status === 'busy'
          ? h('span.signin-who', {}, '⏳ Checking…')
          : h('span.signin-who.none', {}, 'Not signed in');
    const body = h('div.signin-body');
    if (s.error) body.append(h('p.team-status.error', {}, s.error));
    if (s.status === 'ok') {
      const out = h('button.btn', { type: 'button' }, 'Sign out');
      out.addEventListener('click', () => confirmDialog('Sign out of GitLab?', 'Workers you hire from now on can’t push to your GitLab until you sign in again.', 'Sign out', () => net.send({ t: 'gitlab.signout' })));
      body.append(h('div.signin-actions', {}, out));
    } else if (s.status === 'none') {
      body.append(
        h('p.note', {}, 'Your own GitLab: its address, and a personal access token with the ', h('code', {}, 'api'), ' and ', h('code', {}, 'write_repository'), ' scopes (in GitLab, ', h('b', {}, 'Preferences → Access tokens'), '). Your workers push and open merge requests with it, through ', h('code', {}, 'git'), ' and ', h('code', {}, 'glab'), '.'),
        form,
      );
    }
    const typing = document.activeElement;
    el.replaceChildren(h('div.team-head', {}, h('h4', {}, '🦊 GitLab'), status), body);
    for (const i of [url, token]) if (typing === i && i.isConnected) i.focus();
  };

  const unsub = [store.on('gitlab', render), store.on('me', render)];
  render();
  if (store.me.account) net.send({ t: 'gitlab.get' });
  return { el, dispose: () => unsub.forEach((off) => off()) };
}

function host(url: string | undefined): string {
  try {
    return url ? new URL(url).host : 'GitLab';
  } catch {
    return 'GitLab';
  }
}
