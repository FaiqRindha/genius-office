// The boards of a floor whose project is on a self-hosted GitLab (see gitlab-projects.ts): the same
// as GitHub's (github.ts), so the page shows them the same way, but asked of GitLab's API with a
// token. What the office does for someone (comment, label, close, assign) is done with their own
// token (`as`, from GitLabSignIns.ghAs); reading the boards is done with the token of whoever added
// the floor, or anyone signed in to that GitLab when they've signed out.
import type { GhComment, GhIssue, GhIssueDetail, GhLabel, GhPull, GhPullDetail, GhRepoInfo, GhState, GhCloseReason, GhMergeMethod } from '../shared/protocol.js';
import { Claims, type Boards } from './github.js';
import type { GhAs } from './signins.js';

const REFRESH_MS = 90_000;
const LABELS_MS = 60_000;
const TIMEOUT_MS = 30_000;
const OPEN_PAGES = 3;
const PER_PAGE = 100;
const CLOSED = 40;

/** A GitLab, and a token for it. */
export interface GitLabCreds {
  url: string;
  token: string;
}

/** Calls GitLab's API: resolves to what it answered, or rejects with why not, in words. */
export type GitLabApi = (c: GitLabCreds, method: string, rest: string, body?: unknown) => Promise<any>;

export const gitlabApi: GitLabApi = async (c, method, rest, body) => {
  const host = new URL(c.url).host;
  let res: Response;
  try {
    res = await fetch(`${c.url}/api/v4/${rest}`, {
      method,
      headers: { 'PRIVATE-TOKEN': c.token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    });
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    throw new Error(`Couldn't reach ${host}: ${cause?.code ?? cause?.message ?? (err as Error).message}`);
  }
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (res.ok) return json;
  if (res.status === 401) throw new Error(`${host} stopped taking the GitLab token: sign in again (☰ → 🔐 Your sign-ins)`);
  const said = typeof json?.message === 'string' ? json.message : typeof json?.error === 'string' ? json.error : json?.message ? JSON.stringify(json.message) : '';
  if (res.status === 403) throw new Error(`${host} won't let this GitLab account do that${said ? `: ${said}` : ''}`);
  if (res.status === 404) throw new Error(`${host} has nothing there that this GitLab account can see`);
  throw new Error(`${host} answered ${res.status}${said ? `: ${said}` : ''}`);
};

/** The creds in what GitLabSignIns.ghAs hands over: someone's own GitLab sign-in. */
function credsOf(as: GhAs | undefined): GitLabCreds | undefined {
  const url = as?.env.GITLAB_HOST;
  const token = as?.env.GITLAB_TOKEN;
  return url && token ? { url, token } : undefined;
}

function labelsOf(raw: any): GhLabel[] {
  return (Array.isArray(raw) ? raw : []).map((l: any) => (typeof l === 'string' ? { name: l, color: '#888888' } : { name: String(l.name), color: typeof l.color === 'string' ? l.color : '#888888', ...(l.description ? { description: String(l.description) } : {}) }));
}

function issueOf(i: any): GhIssue {
  return {
    number: Number(i.iid),
    title: String(i.title ?? ''),
    state: i.state === 'opened' ? 'OPEN' : 'CLOSED',
    url: String(i.web_url ?? ''),
    author: i.author?.username ?? '',
    labels: labelsOf(i.labels),
    assignees: (i.assignees ?? []).map((a: any) => String(a.username)),
    createdAt: i.created_at,
    updatedAt: i.updated_at,
    body: String(i.description ?? '').slice(0, 4000),
    comments: Number(i.user_notes_count ?? 0),
  };
}

const MERGE_REQUESTS_LATER = "The office doesn't show GitLab merge requests yet";

export class GitLabBoards implements Boards {
  issues: GhState<GhIssue> = { items: [], fetchedAt: 0, loading: false };
  pulls: GhState<GhPull> = { items: [], fetchedAt: 0, loading: false };
  private timer?: NodeJS.Timeout;
  private login?: Promise<string>;
  private labelList?: { at: number; list: Promise<GhLabel[]> };
  private relabeled = new Map<number, { labels: GhLabel[]; at: number }>();
  private claims = new Claims();
  private listing?: Promise<void>;

  constructor(
    /** The project's page: https://gitlab.example.com/group/project */
    private project: string,
    /** Whose token reads the boards (and acts for whoever has none of their own): undefined when nobody's. */
    private reader: () => GitLabCreds | undefined,
    private onIssues: (s: GhState<GhIssue>) => void,
    private onPulls: (s: GhState<GhPull>) => void,
    private api: GitLabApi = gitlabApi,
  ) {}

  start() {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
  }

  stop() {
    clearInterval(this.timer);
  }

  async refresh() {
    await Promise.all([this.refreshIssues(), this.refreshPulls()]);
  }

  repoInfo(): Promise<GhRepoInfo> {
    return Promise.resolve({ nameWithOwner: this.path(this.reader()) ?? this.project, methods: ['merge', 'squash'] });
  }

  /** Who the boards are read as (and comments made for anyone without their own GitLab): '' when nobody. */
  viewer(): Promise<string> {
    const c = this.reader();
    if (!c) return Promise.resolve('');
    this.login ??= this.api(c, 'GET', 'user').then((u) => String(u?.username ?? ''));
    this.login.catch(() => (this.login = undefined));
    return this.login.catch(() => '');
  }

  pullDetail(_n: number, _me?: string): Promise<GhPullDetail> {
    return Promise.reject(new Error(MERGE_REQUESTS_LATER));
  }

  pullDiff(_n: number): Promise<string> {
    return Promise.reject(new Error(MERGE_REQUESTS_LATER));
  }

  async issueDetail(n: number, me?: string): Promise<GhIssueDetail> {
    const c = this.creds();
    const [i, notes, viewer] = await Promise.all([this.call(c, 'GET', `issues/${n}`), this.call(c, 'GET', `issues/${n}/notes?sort=asc&order_by=created_at&per_page=100`), me ?? this.viewer()]);
    const comments: GhComment[] = (Array.isArray(notes) ? notes : [])
      // GitLab's own "changed the description", "added label" lines aren't anyone's comments.
      .filter((note: any) => !note.system)
      .map((note: any) => ({ id: String(note.id), author: note.author?.username ?? 'ghost', body: String(note.body ?? ''), createdAt: note.created_at ?? '', url: i.web_url ? `${i.web_url}#note_${note.id}` : undefined }));
    return { number: Number(i.iid), state: i.state === 'opened' ? 'OPEN' : 'CLOSED', body: String(i.description ?? ''), comments, viewer };
  }

  async comment(kind: 'issue' | 'pull', n: number, body: string, as?: GhAs): Promise<{ comment?: GhComment; error?: string }> {
    if (kind === 'pull') return { error: MERGE_REQUESTS_LATER };
    try {
      const note = await this.call(this.creds(as), 'POST', `issues/${n}/notes`, { body });
      const url = this.issues.items.find((i) => i.number === n)?.url;
      void this.refreshIssues();
      return { comment: { id: String(note.id), author: note.author?.username ?? '', body: String(note.body ?? body), createdAt: note.created_at ?? new Date().toISOString(), url: url ? `${url}#note_${note.id}` : undefined } };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  review(_n: number, _file: string, _as?: GhAs): Promise<string> {
    return Promise.reject(new Error(MERGE_REQUESTS_LATER));
  }

  async merge(_n: number, _method: GhMergeMethod, _deleteBranch: boolean, _auto: boolean, _as?: GhAs): Promise<string | undefined> {
    return MERGE_REQUESTS_LATER;
  }

  /** Closes an issue, after its comment if there is one. GitLab has no "not planned": it's just closed. */
  async close(kind: 'issue' | 'pull', n: number, opts: { comment?: string; reason?: GhCloseReason; deleteBranch?: boolean }, as?: GhAs): Promise<string | undefined> {
    if (kind === 'pull') return MERGE_REQUESTS_LATER;
    try {
      const c = this.creds(as);
      if (opts.comment) await this.call(c, 'POST', `issues/${n}/notes`, { body: opts.comment });
      await this.call(c, 'PUT', `issues/${n}`, { state_event: 'close' });
    } catch (err) {
      return (err as Error).message;
    }
    void this.refreshIssues().then(() => {
      if (this.issues.items.some((i) => i.number === n && i.state === 'OPEN')) setTimeout(() => void this.refreshIssues(), 3000);
    });
    return undefined;
  }

  /** Every label the project can use (its own and its groups'), for the label picker. */
  repoLabels(): Promise<GhLabel[]> {
    if (!this.labelList || Date.now() - this.labelList.at > LABELS_MS) {
      const list = (async () => labelsOf(await this.call(this.creds(), 'GET', `labels?per_page=100&include_ancestor_groups=true`)))();
      this.labelList = { at: Date.now(), list };
      list.catch(() => this.labelList?.list === list && (this.labelList = undefined));
    }
    return this.labelList.list;
  }

  async setLabels(kind: 'issue' | 'pull', n: number, add: string[], remove: string[], as?: GhAs): Promise<{ labels?: GhLabel[]; error?: string }> {
    if (kind === 'pull') return { error: MERGE_REQUESTS_LATER };
    // GitLab takes them as one comma-separated list.
    if ([...add, ...remove].some((l) => l.includes(','))) return { error: "GitLab labels can't have a comma in them" };
    let now: GhLabel[];
    try {
      const i = await this.call(this.creds(as), 'PUT', `issues/${n}`, { add_labels: add.join(','), remove_labels: remove.join(',') });
      // It answers with their names: their colors are the project's.
      const known = await this.repoLabels().catch(() => [] as GhLabel[]);
      now = labelsOf(i.labels).map((l) => known.find((k) => k.name === l.name) ?? l);
    } catch (err) {
      void this.refreshIssues();
      return { error: (err as Error).message };
    }
    const at = Date.now();
    this.relabeled.set(n, { labels: now, at });
    this.issues = { ...this.issues, items: this.relabel(this.issues.items, at) };
    this.onIssues(this.issues);
    void this.refreshIssues();
    return { labels: now };
  }

  /** A worker took the issue: In progress at once, and assigned on GitLab to `as` (else whoever reads the boards). */
  async claim(issue: number, as?: GhAs): Promise<string | undefined> {
    const answered = this.claims.take(issue);
    this.showClaims();
    try {
      const c = this.creds(as);
      const me = await this.api(c, 'GET', 'user');
      await this.call(c, 'PUT', `issues/${issue}`, { assignee_ids: [me.id] });
    } catch (err) {
      answered(false);
      this.showClaims();
      return (err as Error).message;
    }
    answered(true);
    void this.refreshIssues().then(() => (this.claims.has(issue) ? this.refreshIssues() : undefined));
    return undefined;
  }

  // ---------------------------------------------------------------------------

  /** `as`'s own GitLab, else the boards' reader; throws when there's neither. */
  private creds(as?: GhAs): GitLabCreds {
    const c = credsOf(as) ?? this.reader();
    if (!c) throw new Error(`Nobody signed in to ${new URL(this.project).host} can read ${this.project} — sign in to GitLab (☰ → 🔐 Your sign-ins)`);
    return c;
  }

  /** The project's path on the GitLab `c` signs in to; undefined when `c` is for another GitLab. */
  private path(c: GitLabCreds | undefined): string | undefined {
    if (!c) return undefined;
    const base = `${c.url.toLowerCase()}/`;
    return this.project.toLowerCase().startsWith(base) ? this.project.slice(base.length) : undefined;
  }

  /** Asks GitLab about this project: `rest` is under /projects/:id/. */
  private call(c: GitLabCreds, method: string, rest: string, body?: unknown): Promise<any> {
    const path = this.path(c);
    if (!path) return Promise.reject(new Error(`Your GitLab sign-in is for ${new URL(c.url).host}, not ${new URL(this.project).host}`));
    return this.api(c, method, `projects/${encodeURIComponent(path)}/${rest}`, body);
  }

  private relabel(items: GhIssue[], asked: number): GhIssue[] {
    return items.map((it) => {
      const r = this.relabeled.get(it.number);
      if (!r) return it;
      if (r.at < asked) {
        this.relabeled.delete(it.number);
        return it;
      }
      return { ...it, labels: r.labels };
    });
  }

  private showClaims() {
    this.issues = { ...this.issues, items: this.claims.mark(this.issues.items) };
    this.onIssues(this.issues);
  }

  private refreshIssues(): Promise<void> {
    this.listing ??= this.listIssues().finally(() => (this.listing = undefined));
    return this.listing;
  }

  private async listIssues() {
    this.issues = { ...this.issues, loading: true };
    this.onIssues(this.issues);
    const asked = Date.now();
    try {
      const c = this.creds();
      // Open and closed separately, so old open issues are never crowded out by recent closed ones.
      const open: any[] = [];
      for (let page = 1; page <= OPEN_PAGES; page++) {
        const got = await this.call(c, 'GET', `issues?state=opened&with_labels_details=true&order_by=updated_at&per_page=${PER_PAGE}&page=${page}`);
        open.push(...(Array.isArray(got) ? got : []));
        if (!Array.isArray(got) || got.length < PER_PAGE) break;
      }
      const closed = await this.call(c, 'GET', `issues?state=closed&with_labels_details=true&order_by=updated_at&per_page=${CLOSED}`);
      const fetched = [...open, ...(Array.isArray(closed) ? closed : [])].map(issueOf);
      this.issues = { items: this.claims.mark(this.relabel(fetched, asked), asked), fetchedAt: Date.now(), loading: false };
    } catch (err) {
      this.issues = { ...this.issues, loading: false, error: (err as Error).message, fetchedAt: Date.now() };
    }
    this.onIssues(this.issues);
  }

  /** Merge requests come with the next part: until then the board is empty, without an error. */
  private async refreshPulls() {
    this.pulls = { items: [], fetchedAt: Date.now(), loading: false };
    this.onPulls(this.pulls);
  }
}
