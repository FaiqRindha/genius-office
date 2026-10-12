import './elevator-gitlab.css';
import type { GitLabProject } from '../../shared/protocol';
import { cloneStep } from '../../shared/floors';
import type { Net } from '../net';
import { store } from '../state';
import { h, timeAgo } from './dom';

// The elevator's "add a project" for someone signed in to a self-hosted GitLab (see
// server/gitlab-projects.ts): their GitLab's projects in place of GitHub's repositories. Picking one
// clones it with their own token and makes it a new floor. One of the two at a time: the elevator
// shows this one while you're signed in to GitLab.

const SHOWN = 60;
/** Ask GitLab for the projects again after this long. */
const STALE_MS = 5 * 60_000;
/** Longer than the office takes to ask GitLab about a project before its clone starts. */
const START_MS = 60_000;

/** You're signed in to GitLab, so the elevator adds projects from there. */
export function addsFromGitLab(): boolean {
  return store.gitlab?.status === 'ok';
}

/** A floor's GitLab project, as the elevator shows it: gitlab.example.com/group/project */
export function gitlabLabel(url: string | undefined): string | undefined {
  return url?.replace(/^https?:\/\//, '');
}

/** The floor for the project at `path` on your GitLab, if there is one (or one on its way). */
function floorOf(path: string) {
  const url = store.gitlab?.url;
  return url ? store.floors.find((f) => f.gitlab?.toLowerCase() === `${url}/${path}`.toLowerCase()) : undefined;
}

export interface GitLabAdder {
  el: HTMLElement;
  /** Draws it again, from what the store has now. */
  render(): void;
  /** Leaves the store be: the elevator closed. */
  dispose(): void;
}

/** The "add a project" panel for GitLab; `ride` goes to a floor (closing the elevator). */
export function gitlabAdder(net: Net, ride: (floor: string) => void, setup: boolean): GitLabAdder {
  let filter = '';
  let selected: string | null = null;
  let adding: string | null = null;
  let error = '';
  let startTimer: number | undefined;
  let built = false;

  const el = h('div');
  const input = h('input', { type: 'text', placeholder: 'Search your GitLab projects, or type group/project', 'aria-label': 'GitLab project', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
  const listEl = h('div.repo-list', { role: 'listbox', 'aria-label': 'GitLab projects' });
  const statusEl = h('div');
  const addBtn = h('button.btn.primary', { type: 'button' }, '🛗 Add floor');
  const refreshBtn = h('button.btn', { type: 'button', title: 'Ask GitLab for the list again' }, '↻');

  const need = (refresh = false) => {
    const p = store.gitlabProjects;
    if (!refresh && (p.loading || (p.at && Date.now() - p.at < STALE_MS && !p.error))) return;
    store.gitlabProjects = { ...p, loading: true, error: undefined };
    net.send({ t: 'gitlab.projects', refresh });
  };

  /** What "Add floor" would add: the row picked, else what's typed if it's group/project. */
  const choice = (): string | undefined => selected ?? (/^[\w.-]+(\/[\w.-]+)+$/.test(filter.trim()) ? filter.trim().replace(/\/+$/, '') : undefined);

  const row = (p: GitLabProject) => {
    const floor = floorOf(p.path);
    const sel = selected === p.path;
    const r = h(
      'div.repo',
      { role: 'option', class: sel ? 'sel' : '', 'aria-selected': String(sel), title: p.description ?? p.path },
      h('span.nm', {}, p.path),
      h('span.desc', {}, p.description ?? ''),
      floor ? h('span.pill', {}, floor.id === store.floor ? 'you are here' : `floor ${store.floors.indexOf(floor) + 1}`) : p.pushedAt ? h('span.when', {}, timeAgo(p.pushedAt)) : null,
    );
    r.addEventListener('click', () => {
      if (adding) return;
      if (floor) {
        if (floor.id !== store.floor && !floor.cloning) ride(floor.id);
        return;
      }
      selected = p.path;
      render();
    });
    r.addEventListener('dblclick', () => {
      if (!floor) add(p.path);
    });
    return r;
  };

  const add = (path: string) => {
    if (adding) return;
    adding = path;
    error = '';
    store.gitlabAdded = null;
    render();
    net.send({ t: 'gitlab.add', path });
    // The office went away before it answered (a restart): don't wait forever.
    clearTimeout(startTimer);
    startTimer = window.setTimeout(() => {
      if (adding !== path || floorOf(path)) return;
      adding = null;
      error = `The office didn't start cloning ${path} — try again`;
      render();
    }, START_MS);
  };

  const onAdded = () => {
    const m = store.gitlabAdded;
    if (!m || !adding || m.path !== adding) return;
    adding = null;
    clearTimeout(startTimer);
    if (m.floor) return ride(m.floor);
    error = m.error ?? 'The floor could not be added';
    render();
  };

  const render = () => {
    const p = store.gitlabProjects;
    const host = gitlabLabel(store.gitlab?.url) ?? 'GitLab';
    const q = filter.trim().toLowerCase();
    const matches = p.list.filter((x) => !q || x.path.toLowerCase().includes(q) || x.name.toLowerCase().includes(q) || (x.description ?? '').toLowerCase().includes(q));
    const rows: HTMLElement[] = [];
    const typed = choice();
    if (typed && !selected && !p.list.some((x) => x.path.toLowerCase() === typed.toLowerCase())) rows.push(row({ path: typed, name: typed, description: 'Not in your list — the office will try to clone it' }));
    rows.push(...matches.slice(0, SHOWN).map(row));
    if (!rows.length) rows.push(h('p.empty', { style: 'padding:10px' }, p.loading ? `Asking ${host} for your projects…` : p.error ? '' : q ? 'Nothing matches. Type group/project to clone any project you can see.' : 'No projects.'));
    if (matches.length > SHOWN) rows.push(h('p.empty', { style: 'padding:8px 10px' }, `…and ${matches.length - SHOWN} more — type to narrow it down`));
    listEl.replaceChildren(...rows);
    const pick = choice();
    const on = adding ? floorOf(adding) : undefined;
    // Where the office clones it (see Building.addGitLab): <host>/<group.subgroup>/<project>.
    const where = pick ? `${pick.split('/').slice(0, -1).join('.')}/${pick.split('/').pop()}` : '<group>/<project>';
    const dest = `${store.projectsDir.dir}/${store.gitlab?.url ? new URL(store.gitlab.url).host.replace(/:/g, '_') : '<host>'}/${where}`;
    const lines: (HTMLElement | null)[] = adding
      ? [
          h('p.note.busy', {}, on ? `⏳ Cloning ${adding} from ${host}` : `⏳ Asking ${host} about ${adding}…`),
          on?.clone ? h('p.note', {}, [cloneStep(on.clone), on.clone.detail].filter(Boolean).join(' · ')) : null,
          h('p.note', {}, 'You can close this and carry on: everyone hears when the new floor opens.'),
        ]
      : [h('p.note', {}, `Cloned into ${dest} with your own GitLab sign-in (${store.gitlab?.who ?? ''}). Everything on the new floor works in that checkout.`)];
    statusEl.replaceChildren(...lines.filter((l): l is HTMLElement => !!l), ...[p.error, error].filter(Boolean).map((e) => h('p.err', {}, e!)));
    addBtn.disabled = !!adding || !pick || !!floorOf(pick);
    addBtn.textContent = adding ? '⏳ Cloning…' : pick ? `🛗 Add ${pick}` : '🛗 Add floor';
    input.disabled = !!adding;
    if (!built) {
      built = true;
      el.replaceChildren(
        h('h3', {}, setup && !store.floors.length ? `Pick your first project from ${host}` : `➕ Add a project from 🦊 ${host}`),
        h('div.repo-search', {}, input, refreshBtn),
        listEl,
        statusEl,
        h('div.gitlab-add', {}, addBtn),
      );
    }
  };

  input.addEventListener('input', () => {
    filter = input.value;
    if (selected && selected !== choice()) selected = null;
    render();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    const q = filter.trim().toLowerCase();
    const matches = store.gitlabProjects.list.filter((x) => !floorOf(x.path) && (x.path.toLowerCase().includes(q) || x.name.toLowerCase().includes(q)));
    const pick = choice() ?? (q && matches.length === 1 ? matches[0].path : undefined);
    if (pick) add(pick);
  });
  addBtn.addEventListener('click', () => {
    const pick = choice();
    if (pick) add(pick);
  });
  refreshBtn.addEventListener('click', () => need(true));

  const unsubs = [store.on('gitlabProjects', render), store.on('gitlabAdded', onAdded), store.on('floors', render)];
  need();
  render();
  setTimeout(() => input.focus(), 30);
  return { el, render, dispose: () => (clearTimeout(startTimer), unsubs.forEach((off) => off())) };
}

/**
 * Whether floor `f` is a GitLab project you're not a member of (see server/gitlab-access.ts): it
 * stays locked to you, its button 🔒 in the elevator. Unsure (your roles not in yet): not locked;
 * the office checks again when you go.
 */
export function gitlabLocked(f: { gitlab?: string }): boolean {
  const levels = store.gitlabAccess;
  if (!f.gitlab || !levels) return false;
  const path = (() => {
    try {
      return new URL(f.gitlab).pathname.replace(/^\/+|\/+$/g, '').toLowerCase();
    } catch {
      return '';
    }
  })();
  for (const d of store.gitlabWorld?.districts ?? []) {
    for (const b of d.buildings) {
      const floor = b.floors.find((x) => path.endsWith(x.path.toLowerCase()));
      if (floor) return !(levels[floor.projectId] >= 10);
    }
  }
  return false;
}
