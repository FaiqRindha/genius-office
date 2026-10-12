// GitLab's merge requests as the office's pull requests (see gitlab-boards.ts): what GitLab's API
// says about one, turned into what the PR board and window show for GitHub's, so they show the same.
import type { GhCheck, GhComment, GhLabel, GhPull, GhReviewComment } from '../shared/protocol.js';

/** "Closes #12", "fixes #3, #4": GitLab's default closing pattern, for the issues an MR closes. */
const CLOSES = /\b(?:clos(?:e[sd]?|ing)|fix(?:e[sd]|ing)?|resolv(?:e[sd]?|ing)|implement(?:s|ed|ing)?)\b:?((?:\s*(?:,|and)?\s*#\d+)+)/gi;

/** The issues an MR's description says it closes. */
export function closesOf(body: string): number[] {
  const out = new Set<number>();
  for (const m of body.matchAll(CLOSES)) for (const n of m[1].matchAll(/#(\d+)/g)) out.add(Number(n[1]));
  return [...out].filter((n) => Number.isSafeInteger(n) && n > 0);
}

/** A pipeline's or job's status, as a check. */
export function checkState(status: unknown): GhCheck['state'] {
  if (status === 'success') return 'pass';
  if (status === 'failed' || status === 'canceled') return 'fail';
  if (status === 'skipped' || status === 'manual') return 'skip';
  return 'pending';
}

/** What a pipeline adds up to, for the PR card: none when there's no pipeline. */
export function cardChecks(status: unknown): GhPull['checks'] {
  if (!status) return 'none';
  const s = checkState(status);
  return s === 'skip' ? 'none' : s;
}

/** GitLab's MR states, as GitHub's. */
export function prState(state: unknown): string {
  return state === 'merged' ? 'MERGED' : state === 'opened' ? 'OPEN' : 'CLOSED';
}

export function labelsOf(raw: any): GhLabel[] {
  return (Array.isArray(raw) ? raw : []).map((l: any) => (typeof l === 'string' ? { name: l, color: '#888888' } : { name: String(l.name), color: typeof l.color === 'string' ? l.color : '#888888', ...(l.description ? { description: String(l.description) } : {}) }));
}

/** An MR in GitLab's list, as a PR card. `pipelines` is each commit's latest pipeline status. */
export function pullOf(m: any, pipelines: Map<string, string>): GhPull {
  const body = String(m.description ?? '');
  return {
    number: Number(m.iid),
    title: String(m.title ?? ''),
    state: prState(m.state),
    isDraft: !!(m.draft ?? m.work_in_progress),
    url: String(m.web_url ?? ''),
    author: m.author?.username ?? '',
    labels: labelsOf(m.labels),
    reviewDecision: m.detailed_merge_status === 'not_approved' ? 'REVIEW_REQUIRED' : '',
    headRefName: String(m.source_branch ?? ''),
    headRefOid: typeof m.sha === 'string' ? m.sha : undefined,
    baseRefName: String(m.target_branch ?? ''),
    createdAt: m.created_at ?? '',
    updatedAt: m.updated_at ?? m.created_at ?? '',
    // GitLab's list doesn't count lines.
    additions: 0,
    deletions: 0,
    checks: cardChecks(typeof m.sha === 'string' ? pipelines.get(m.sha) : undefined),
    body: body.slice(0, 4000),
    closes: closesOf(body),
  };
}

/** Whether an MR can merge, in GitHub's words (mergeable, mergeStateStatus), from GitLab's. */
export function mergeability(m: any): { mergeable: string; mergeStateStatus: string } {
  const detailed = String(m.detailed_merge_status ?? '');
  const mergeable = m.has_conflicts ? 'CONFLICTING' : ['checking', 'unchecked', 'preparing'].includes(detailed) || ['checking', 'unchecked'].includes(m.merge_status) ? 'UNKNOWN' : 'MERGEABLE';
  const status: Record<string, string> = {
    mergeable: 'CLEAN',
    conflict: 'DIRTY',
    need_rebase: 'BEHIND',
    draft_status: 'DRAFT',
    ci_still_running: 'UNSTABLE',
    checking: 'UNKNOWN',
    unchecked: 'UNKNOWN',
    preparing: 'UNKNOWN',
    approvals_syncing: 'UNKNOWN',
  };
  if (detailed) return { mergeable, mergeStateStatus: status[detailed] ?? 'BLOCKED' };
  // Older GitLabs only say merge_status.
  return { mergeable, mergeStateStatus: m.has_conflicts ? 'DIRTY' : m.merge_status === 'can_be_merged' ? 'CLEAN' : mergeable === 'UNKNOWN' ? 'UNKNOWN' : 'BLOCKED' };
}

/** An MR's notes: the conversation (comments) and the ones on lines of its diff (reviewComments). */
export function notesOf(notes: any[], mrUrl: string): { comments: GhComment[]; reviewComments: GhReviewComment[] } {
  const comments: GhComment[] = [];
  const reviewComments: GhReviewComment[] = [];
  for (const n of Array.isArray(notes) ? notes : []) {
    // GitLab's own "added 1 commit", "approved this merge request" lines aren't anyone's comments.
    if (n.system) continue;
    const url = mrUrl ? `${mrUrl}#note_${n.id}` : undefined;
    const p = n.position;
    if (n.type === 'DiffNote' && p) {
      const right = p.new_line != null;
      reviewComments.push({
        id: Number(n.id),
        author: n.author?.username ?? 'ghost',
        body: String(n.body ?? ''),
        createdAt: n.created_at ?? '',
        url: url ?? '',
        path: String(p.new_path ?? p.old_path ?? ''),
        line: right ? Number(p.new_line) : p.old_line != null ? Number(p.old_line) : null,
        side: right ? 'RIGHT' : 'LEFT',
      });
    } else comments.push({ id: String(n.id), author: n.author?.username ?? 'ghost', body: String(n.body ?? ''), createdAt: n.created_at ?? '', url });
  }
  return { comments, reviewComments };
}

/** A pipeline's jobs as checks, the last run of each. */
export function checksOf(jobs: any[]): GhCheck[] {
  const latest = new Map<string, any>();
  for (const j of Array.isArray(jobs) ? jobs : []) {
    const key = `${j.stage}/${j.name}`;
    if (!latest.has(key) || Number(j.id) > Number(latest.get(key).id)) latest.set(key, j);
  }
  return [...latest.values()].map((j) => ({ name: j.stage ? `${j.stage} / ${j.name}` : String(j.name), state: checkState(j.status), url: typeof j.web_url === 'string' ? j.web_url : undefined }));
}

/** An MR's changed files, as one unified diff (what `gh pr diff` gives for GitHub's). */
export function diffText(changes: any[]): string {
  return (Array.isArray(changes) ? changes : [])
    .map((c) => {
      const a = c.new_file ? '/dev/null' : `a/${c.old_path}`;
      const b = c.deleted_file ? '/dev/null' : `b/${c.new_path}`;
      const head = [`diff --git a/${c.old_path} b/${c.new_path}`];
      if (c.new_file) head.push('new file mode 100644');
      if (c.deleted_file) head.push('deleted file mode 100644');
      if (c.renamed_file) head.push(`rename from ${c.old_path}`, `rename to ${c.new_path}`);
      const diff = String(c.diff ?? '');
      if (diff) head.push(`--- ${a}`, `+++ ${b}`, diff.endsWith('\n') ? diff.slice(0, -1) : diff);
      return head.join('\n');
    })
    .join('\n');
}
