import { store } from '../state';

// Where the floor you're on keeps its issues and pull requests: GitHub, or a self-hosted GitLab
// (see server/gitlab-boards.ts). The boards are the same either way; this is for what they say.

/** The floor you're on is a project on a GitLab. */
export function onGitLab(): boolean {
  return !!store.currentFloor()?.gitlab;
}

/** "GitHub" or "GitLab", for the floor you're on. */
export function forgeName(): string {
  return onGitLab() ? 'GitLab' : 'GitHub';
}
