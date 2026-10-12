import type { GitLabProject, GitLabState, ServerMsg } from '../../../shared/protocol';
import type { Slice } from '../store';

declare module '../store' {
  interface Store {
    /** Your own self-hosted GitLab sign-in; only accounts have one. */
    gitlab: GitLabState | null;
    /** The projects it can see, for the elevator's "add a project" (`at`: when they came). */
    gitlabProjects: { list: GitLabProject[]; loading: boolean; error?: string; at: number };
    /** The office's last answer to a GitLab project you added. */
    gitlabAdded: Extract<ServerMsg, { t: 'gitlab.added' }> | null;
  }
  interface Topics {
    gitlab: true;
    gitlabProjects: true;
    gitlabAdded: true;
  }
}

export const gitlab: Slice = {
  init(s) {
    s.gitlab = null;
    s.gitlabProjects = { list: [], loading: false, at: 0 };
    s.gitlabAdded = null;
  },
  on: {
    gitlab(s, m) {
      // Signed out, or signed in somewhere else: its projects were someone else's list.
      if (m.state.url !== s.gitlab?.url || m.state.status !== 'ok') s.gitlabProjects = { list: [], loading: false, at: 0 };
      s.gitlab = m.state;
      return ['gitlab', 'gitlabProjects'];
    },
    'gitlab.projects'(s, m) {
      s.gitlabProjects = { list: m.projects, loading: false, error: m.error, at: Date.now() };
      return ['gitlabProjects'];
    },
    'gitlab.added'(s, m) {
      s.gitlabAdded = m;
      return ['gitlabAdded'];
    },
  },
};
