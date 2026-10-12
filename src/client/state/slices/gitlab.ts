import type { GitLabState } from '../../../shared/protocol';
import type { Slice } from '../store';

declare module '../store' {
  interface Store {
    /** Your own self-hosted GitLab sign-in; only accounts have one. */
    gitlab: GitLabState | null;
  }
  interface Topics {
    gitlab: true;
  }
}

export const gitlab: Slice = {
  init(s) {
    s.gitlab = null;
  },
  on: {
    gitlab(s, m) {
      s.gitlab = m.state;
      return ['gitlab'];
    },
  },
};
