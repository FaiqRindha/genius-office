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

/** A project your GitLab sign-in can see, for the elevator's "add a project". */
export interface GitLabProject {
  /** group/project (or group/sub/project) */
  path: string;
  name: string;
  description?: string;
  /** ISO time it was last active. */
  pushedAt?: string;
}

export type GitLabClientMsg =
  /** Your GitLab sign-in (accounts only): look at it again. */
  | { t: 'gitlab.get' }
  /** A personal access token for the GitLab at `url`. */
  | { t: 'gitlab.token'; url: string; token: string }
  | { t: 'gitlab.signout' }
  /** The projects your GitLab sign-in can see; answered with `gitlab.projects`. */
  | { t: 'gitlab.projects'; refresh?: boolean }
  /** Clone a project from your GitLab and make it a new floor; answered with `gitlab.added` once it's there. */
  | { t: 'gitlab.add'; path: string };

export type GitLabServerMsg =
  /** Your GitLab sign-in, whenever it changes (accounts only). */
  | { t: 'gitlab'; state: GitLabState }
  | { t: 'gitlab.projects'; projects: GitLabProject[]; error?: string }
  /** The floor for the project at `path` is there, or why there's none. */
  | { t: 'gitlab.added'; path: string; floor?: string; error?: string };
