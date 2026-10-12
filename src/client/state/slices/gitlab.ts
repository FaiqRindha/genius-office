import type { GitLabProject, GitLabState, ServerMsg } from '../../../shared/protocol';
import type { WorldState } from '../../../shared/gitlab-world';
import type { Slice } from '../store';

declare module '../store' {
  interface Store {
    /** Your own self-hosted GitLab sign-in; only accounts have one. */
    gitlab: GitLabState | null;
    /** The projects it can see, for the elevator's "add a project" (`at`: when they came). */
    gitlabProjects: { list: GitLabProject[]; loading: boolean; error?: string; at: number };
    /** The office's last answer to a GitLab project you added. */
    gitlabAdded: Extract<ServerMsg, { t: 'gitlab.added' }> | null;
    /** Every project on the GitLab, as districts, buildings and floors (see shared/gitlab-world.ts). */
    gitlabWorld: WorldState | null;
    /** Your role in each of its projects (GitLab access level, by project id): null before the office has said. */
    gitlabAccess: Record<number, number> | null;
    /** The office's last answer to going onto a GitLab project's floor. */
    gitlabEntered: Extract<ServerMsg, { t: 'gitlab.entered' }> | null;
  }
  interface Topics {
    gitlab: true;
    gitlabProjects: true;
    gitlabAdded: true;
    gitlabWorld: true;
    gitlabAccess: true;
    gitlabEntered: true;
  }
}

export const gitlab: Slice = {
  init(s) {
    s.gitlab = null;
    s.gitlabProjects = { list: [], loading: false, at: 0 };
    s.gitlabAdded = null;
    s.gitlabWorld = null;
    s.gitlabAccess = null;
    s.gitlabEntered = null;
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
    'gitlab.access'(s, m) {
      s.gitlabAccess = m.levels;
      return ['gitlabAccess'];
    },
    'gitlab.entered'(s, m) {
      s.gitlabEntered = m;
      return ['gitlabEntered'];
    },
    'gitlab.world'(s, m) {
      s.gitlabWorld = m.state;
      return ['gitlabWorld'];
    },
    'gitlab.added'(s, m) {
      s.gitlabAdded = m;
      return ['gitlabAdded'];
    },
  },
};
