/**
 * Slack live-token harness — SKIPPED by default in CI.
 *
 * Opt-in via env vars:
 *   SLACK_LIVE=1
 *   SLACK_BOT_TOKEN=xoxb-...
 *   SLACK_APP_TOKEN=xapp-...   (only required if you want to exercise socket mode)
 *   SLACK_WORKSPACE=<workspace handle, informational>
 *   SLACK_CHANNEL=<channel id or name>
 *
 * Run manually:
 *   SLACK_LIVE=1 SLACK_BOT_TOKEN=... SLACK_APP_TOKEN=... \
 *     SLACK_WORKSPACE=acme SLACK_CHANNEL=general \
 *     pnpm vitest run test/live/slack-live.test.ts
 */

import { describe, expect, it } from 'vitest';
import { slackAdapter } from '../../src/channels/adapters/slack.js';

const liveEnabled = process.env.SLACK_LIVE === '1';
const botToken = process.env.SLACK_BOT_TOKEN ?? '';
const appToken = process.env.SLACK_APP_TOKEN ?? '';
const workspace = process.env.SLACK_WORKSPACE ?? '';
const channel = process.env.SLACK_CHANNEL ?? '';
const canRun = liveEnabled && botToken !== '' && workspace !== '' && channel !== '';

describe.skipIf(!canRun)('slackAdapter — live token', () => {
  it('posts a message to the configured channel', async () => {
    const adapter = slackAdapter({ botToken, appToken });
    try {
      const r = await adapter.send(`slack://${workspace}/${channel}`, {
        text: `opensquid live-token check ${new Date().toISOString()}`,
      });
      expect(r.ok).toBe(true);
    } finally {
      await adapter.stop();
    }
  }, 30_000);
});
