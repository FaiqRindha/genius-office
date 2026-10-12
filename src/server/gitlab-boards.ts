// The boards of a floor whose project is on a self-hosted GitLab (see gitlab-projects.ts): the same
// as GitHub's (github.ts), so the page shows them the same way, but asked of GitLab's API with a
// token. What the office does for someone (comment, label, close, assign) is done with their own
// token (`as`, from GitLabSignIns.ghAs); reading the boards is done with the token of whoever added
// the floor, or anyone signed in to that GitLab when they've signed out.
import { readFileSync } from 'node:fs';
import type { GhComment, GhIssue, GhIssueDetail, GhLabel, GhPull, GhPullDetail, GhRepoInfo, GhState, GhCloseReason, GhMergeMethod } from '../shared/protocol.js';
import { Claims, type Boards } from './github.js';
import { checksOf, diffText, labelsOf, mergeability, notesOf, prState, pullOf } from './gitlab-mrs.js';
import type { GhAs } from './signins.js';

const REFRESH_MS = 90_000;
const LABELS_MS = 60_000;
const TIMEOUT_MS = 30_000;
const OPEN_PAGES = 3;
const PER_PAGE = 100;
const CLOSED = 40;
const MRS_OPEN_PAGES = 2;
const MRS_MERGED = 30;
const MRS_CLOSED = 40;
/** Open MRs whose approvals are asked for on each look, newest first. */
const MRS_APPROVALS = 30;

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
  // Merging something that can't merge yet (conflicts, a pipeline that must pass, a draft).
  if ([405, 406, 409, 422].includes(res.status)) throw new Error(`${host} won't do that yet${said ? `: ${said}` : ''}`);
  throw new Error(`${host} answered ${res.status}${said ? `: ${said}` : ''}`);
};

/** The creds in what GitLabSignIns.ghAs hands over: someone's own GitLab sign-in. */
function credsOf(as: GhAs | undefined): GitLabCreds | undefined {
  const url = as?.env.GITLAB_HOST;
  const token = as?.env.GITLAB_TOKEN;
  return url && token ? { url, token } : undefined;
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

/** Where GitLab keeps an issue or an MR (a PR, to the office) under its project. */
const KIND = { issue: 'issues', pull: 'merge_requests' } as const;

export class GitLabBoards implements Boards {
  issues: GhState<GhIssue> = { items: [], fetchedAt: 0, loading: false };
  pulls: GhState<GhPull> = { items: [], fetchedAt: 0, loading: false };
  private timer?: NodeJS.Timeout;
  private login?: Promise<string>;
  private labelList?: { at: number; list: Promise<GhLabel[]> };
  /** Labels just changed from the office, by "issue:N" or "pull:N", and when. */
  private relabeled = new Map<string, { labels: GhLabel[]; at: number }>();
  private claims = new Claims();
  private listing?: Promise<void>;
  private pullListing?: Promise<void>;
  private repo?: Promise<GhRepoInfo>;

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

  /** The project's path, and how it lets MRs merge (its squash setting). Asked once (again after a failure). */
  repoInfo(): Promise<GhRepoInfo> {
    this.repo ??= (async () => {
      const c = this.creds();
      const p = await this.api(c, 'GET', `projects/${encodeURIComponent(this.path(c) ?? '')}`);
      const squash = p?.squash_option;
      const methods: GhMergeMethod[] = squash === 'never' ? ['merge'] : squash === 'always' ? ['squash'] : ['merge', 'squash'];
      return { nameWithOwner: String(p?.path_with_namespace ?? this.path(c)), methods };
    })();
    this.repo.catch(() => (this.repo = undefined));
    return this.repo;
  }

  /** Who the boards are read as (and comments made for anyone without their own GitLab): '' when nobody. */
  viewer(): Promise<string> {
    const c = this.reader();
    if (!c) return Promise.resolve('');
    this.login ??= this.api(c, 'GET', 'user').then((u) => String(u?.username ?? ''));
    this.login.catch(() => (this.login = undefined));
    return this.login.catch(() => '');
  }

  /** An MR's description, conversation, line comments, approvals, pipeline jobs and whether it can merge. */
  async pullDetail(n: number, me?: string): Promise<GhPullDetail> {
    const c = this.creds();
    const [m, notes, commits, approvals, repo, viewer] = await Promise.all([
      this.call(c, 'GET', `merge_requests/${n}`),
      this.call(c, 'GET', `merge_requests/${n}/notes?sort=asc&order_by=created_at&per_page=100`),
      this.call(c, 'GET', `merge_requests/${n}/commits?per_page=100`).catch(() => []),
      this.call(c, 'GET', `merge_requests/${n}/approvals`).catch(() => undefined),
      this.repoInfo(),
      me ?? this.viewer(),
    ]);
    const pipeline = m.head_pipeline;
    const jobs = pipeline?.id ? await this.call(c, 'GET', `pipelines/${pipeline.id}/jobs?per_page=100`).catch(() => []) : [];
    const { comments, reviewComments } = notesOf(notes, String(m.web_url ?? ''));
    const approvedBy: any[] = Array.isArray(approvals?.approved_by) ? approvals.approved_by : [];
    const state = prState(m.state);
    return {
      number: Number(m.iid),
      body: String(m.description ?? ''),
      state,
      isDraft: !!(m.draft ?? m.work_in_progress),
      reviewDecision: approvedBy.length ? 'APPROVED' : m.detailed_merge_status === 'not_approved' ? 'REVIEW_REQUIRED' : '',
      headRefName: String(m.source_branch ?? ''),
      baseRefName: String(m.target_branch ?? ''),
      ...mergeability(m),
      commits: Array.isArray(commits) ? commits.length : 0,
      comments,
      // Approvals are its reviews: GitLab has no review bodies of its own.
      reviews: approvedBy.map((a) => ({ id: `approval:${a.user?.id}`, author: a.user?.username ?? 'ghost', body: '', createdAt: approvals?.updated_at ?? '', state: 'APPROVED' })),
      reviewComments,
      checks: jobs.length ? checksOf(jobs) : pipeline ? checksOf([{ id: pipeline.id, name: 'pipeline', status: pipeline.status, web_url: pipeline.web_url }]) : [],
      repo,
      viewer,
    };
  }

  /** An MR's changes as a unified diff. */
  async pullDiff(n: number): Promise<string> {
    const c = this.creds();
    // GitLab 15.7 and later list them page by page; before that, /changes has them all.
    try {
      const all: any[] = [];
      for (let page = 1; page <= 20; page++) {
        const got = await this.call(c, 'GET', `merge_requests/${n}/diffs?per_page=100&page=${page}`);
        all.push(...(Array.isArray(got) ? got : []));
        if (!Array.isArray(got) || got.length < 100) break;
      }
      return diffText(all);
    } catch {
      return diffText((await this.call(c, 'GET', `merge_requests/${n}/changes`))?.changes);
    }
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
    try {
      const note = await this.call(this.creds(as), 'POST', `${KIND[kind]}/${n}/notes`, { body });
      const url = (kind === 'issue' ? this.issues : this.pulls).items.find((i) => i.number === n)?.url;
      void (kind === 'issue' ? this.refreshIssues() : this.refreshPulls());
      return { comment: { id: String(note.id), author: note.author?.username ?? '', body: String(note.body ?? body), createdAt: note.created_at ?? new Date().toISOString(), url: url ? `${url}#note_${note.id}` : undefined } };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  /** The meeting room's review of an MR: a comment on it, read from a file. Resolves to its URL. */
  async review(n: number, file: string, as?: GhAs): Promise<string> {
    const note = await this.call(this.creds(as), 'POST', `merge_requests/${n}/notes`, { body: readFileSync(file, 'utf8') });
    void this.refreshPulls();
    const url = this.pulls.items.find((p) => p.number === n)?.url;
    return url ? `${url}#note_${note.id}` : '';
  }

  /** Merges an MR, or with `auto` has GitLab merge it once its pipeline succeeds. Returns an error. */
  async merge(n: number, method: GhMergeMethod, deleteBranch: boolean, auto: boolean, as?: GhAs): Promise<string | undefined> {
    try {
      await this.call(this.creds(as), 'PUT', `merge_requests/${n}/merge`, { squash: method === 'squash', should_remove_source_branch: deleteBranch, ...(auto ? { merge_when_pipeline_succeeds: true } : {}) });
    } catch (err) {
      return (err as Error).message;
    }
    void this.refreshPulls();
    return undefined;
  }

  /**
   * Closes an issue, or an MR without merging it (and its branch with `deleteBranch`), after its
   * comment if there is one. GitLab has no "not planned": an issue is just closed.
   */
  async close(kind: 'issue' | 'pull', n: number, opts: { comment?: string; reason?: GhCloseReason; deleteBranch?: boolean }, as?: GhAs): Promise<string | undefined> {
    try {
      const c = this.creds(as);
      if (opts.comment) await this.call(c, 'POST', `${KIND[kind]}/${n}/notes`, { body: opts.comment });
      const closed = await this.call(c, 'PUT', `${KIND[kind]}/${n}`, { state_event: 'close' });
      if (kind === 'pull' && opts.deleteBranch && closed?.source_branch) await this.call(c, 'DELETE', `repository/branches/${encodeURIComponent(closed.source_branch)}`);
    } catch (err) {
      return (err as Error).message;
    }
    const refresh = () => (kind === 'issue' ? this.refreshIssues() : this.refreshPulls());
    void refresh().then(() => {
      if ((kind === 'issue' ? this.issues : this.pulls).items.some((i) => i.number === n && i.state === 'OPEN')) setTimeout(() => void refresh(), 3000);
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
    // GitLab takes them as one comma-separated list.
    if ([...add, ...remove].some((l) => l.includes(','))) return { error: "GitLab labels can't have a comma in them" };
    let now: GhLabel[];
    try {
      const i = await this.call(this.creds(as), 'PUT', `${KIND[kind]}/${n}`, { add_labels: add.join(','), remove_labels: remove.join(',') });
      // It answers with their names: their colors are the project's.
      const known = await this.repoLabels().catch(() => [] as GhLabel[]);
      now = labelsOf(i.labels).map((l) => known.find((k) => k.name === l.name) ?? l);
    } catch (err) {
      void (kind === 'issue' ? this.refreshIssues() : this.refreshPulls());
      return { error: (err as Error).message };
    }
    const at = Date.now();
    this.relabeled.set(`${kind}:${n}`, { labels: now, at });
    if (kind === 'issue') {
      this.issues = { ...this.issues, items: this.relabel('issue', this.issues.items, at) };
      this.onIssues(this.issues);
      void this.refreshIssues();
    } else {
      this.pulls = { ...this.pulls, items: this.relabel('pull', this.pulls.items, at) };
      this.onPulls(this.pulls);
      void this.refreshPulls();
    }
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

  private relabel<T extends GhIssue | GhPull>(kind: 'issue' | 'pull', items: T[], asked: number): T[] {
    return items.map((it) => {
      const key = `${kind}:${it.number}`;
      const r = this.relabeled.get(key);
      if (!r) return it;
      if (r.at < asked) {
        this.relabeled.delete(key);
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
      this.issues = { items: this.claims.mark(this.relabel('issue', fetched, asked), asked), fetchedAt: Date.now(), loading: false };
    } catch (err) {
      this.issues = { ...this.issues, loading: false, error: (err as Error).message, fetchedAt: Date.now() };
    }
    this.onIssues(this.issues);
  }

  private refreshPulls(): Promise<void> {
    this.pullListing ??= this.listPulls().finally(() => (this.pullListing = undefined));
    return this.pullListing;
  }

  /** Asks GitLab for the MRs: open, merged and closed separately, with each one's pipeline. */
  private async listPulls() {
    this.pulls = { ...this.pulls, loading: true };
    this.onPulls(this.pulls);
    const asked = Date.now();
    try {
      const c = this.creds();
      const list = (state: string, perPage: number, page = 1) => this.call(c, 'GET', `merge_requests?state=${state}&with_labels_details=true&order_by=updated_at&per_page=${perPage}&page=${page}`);
      const open: any[] = [];
      for (let page = 1; page <= MRS_OPEN_PAGES; page++) {
        const got = await list('opened', PER_PAGE, page);
        open.push(...(Array.isArray(got) ? got : []));
        if (!Array.isArray(got) || got.length < PER_PAGE) break;
      }
      const [merged, closed, pipelines] = await Promise.all([
        list('merged', MRS_MERGED),
        list('closed', MRS_CLOSED),
        // Each commit's latest pipeline, for the cards' checks, in one ask (not one per MR).
        this.call(c, 'GET', `pipelines?per_page=100&order_by=id&sort=desc`).catch(() => []),
      ]);
      // Who approved the open ones, for the Approved column: GitLab's list doesn't say.
      const approved = new Set<number>();
      await Promise.all(
        open.slice(0, MRS_APPROVALS).map(async (m) => {
          const a = await this.call(c, 'GET', `merge_requests/${m.iid}/approvals`).catch(() => undefined);
          if (Array.isArray(a?.approved_by) && a.approved_by.length) approved.add(Number(m.iid));
        }),
      );
      const latest = new Map<string, string>();
      for (const p of Array.isArray(pipelines) ? pipelines : []) if (typeof p.sha === 'string' && !latest.has(p.sha)) latest.set(p.sha, p.status);
      const seen = new Set<number>();
      const all = [...open, ...(Array.isArray(merged) ? merged : []), ...(Array.isArray(closed) ? closed : [])].filter((m) => !seen.has(m.iid) && seen.add(m.iid));
      const items = all.map((m) => pullOf(m, latest)).map((p) => (approved.has(p.number) && p.state === 'OPEN' ? { ...p, reviewDecision: 'APPROVED' } : p));
      this.pulls = { items: this.relabel('pull', items, asked), fetchedAt: Date.now(), loading: false };
    } catch (err) {
      this.pulls = { ...this.pulls, loading: false, error: (err as Error).message, fetchedAt: Date.now() };
    }
    this.onPulls(this.pulls);
  }
}
