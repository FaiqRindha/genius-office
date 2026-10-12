// Your own GitLab sign-in, for a self-hosted GitLab (see server/gitlab.ts). Accounts only.

/** Your GitLab sign-in, as the office sees it. */
export interface GitLabState {
  /** ok: signed in. none: not yet. busy: checking the token. */
  status: 'ok' | 'none' | 'busy';
  /** The GitLab it signs in to: https://gitlab.example.com (and a path, for one under a path). */
  url?: string;
  /** Who it signs in as: @username. */
  who?: string;
  error?: string;
}

export type GitLabClientMsg =
  /** Your GitLab sign-in (accounts only): look at it again. */
  | { t: 'gitlab.get' }
  /** A personal access token for the GitLab at `url`. */
  | { t: 'gitlab.token'; url: string; token: string }
  | { t: 'gitlab.signout' };

export type GitLabServerMsg =
  /** Your GitLab sign-in, whenever it changes (accounts only). */
  { t: 'gitlab'; state: GitLabState };
