// Your own self-hosted GitLab sign-in (see gitlab.ts). Accounts only: the shared password runs on the office's.
import type { GitLabClientMsg } from '../../../shared/protocol.js';
import type { Ctx } from '../../office/context.js';
import type { Client } from '../../office/client.js';
import { str } from '../../office/input.js';
import type { HandlerMap } from './types.js';

/** The account `c` is signed in with; on the shared password there's none, and they're told why. */
const accountOf = (ctx: Ctx, c: Client): string | undefined => {
  const id = c.accountId;
  if (!id) ctx.warn(c, "On the shared office password, workers run on the office's own GitLab sign-in");
  return id;
};

export const gitlabHandlers = {
  'gitlab.get'(ctx, c) {
    const id = accountOf(ctx, c);
    if (!id) return;
    ctx.sendTo(c, { t: 'gitlab', state: ctx.gitlab.state(id) });
    void ctx.gitlab.look(id);
  },
  'gitlab.token'(ctx, c, msg) {
    const id = accountOf(ctx, c);
    if (!id) return;
    // Why a token didn't take shows on the GitLab card.
    void ctx.gitlab.token(id, str(msg.url, 2048), str(msg.token, 4096));
  },
  'gitlab.signout'(ctx, c) {
    const id = accountOf(ctx, c);
    if (!id) return;
    ctx.gitlab.signOut(id);
  },
} satisfies HandlerMap<GitLabClientMsg>;
