import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import extension from '../auto-reviewer.ts';

// This fixture loads only the public reviewer. No consumer extension is present.
test('standalone Jev reviewer shows actual charges and persists native usage, including failed attempts', async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-native-'));
  const manager = SessionManager.create(cwd, path.join(cwd, 'sessions'));
  manager.appendMessage({ role: 'user', content: 'Run the project tests.', timestamp: Date.now() });
  // Pi flushes earlier entries once an assistant message exists.
  manager.appendMessage({ role: 'assistant', provider: 'fixture', model: 'fixture', api: 'openai-completions', content: [],
    timestamp: Date.now(), stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const keys = ['PI_REVIEWER_BACKEND', 'PI_REVIEWER_PROVIDER', 'PI_REVIEWER_MODEL', 'PI_REVIEWER_ENDPOINT', 'PI_REVIEWER_API_KEY_ENV'];
  const originalEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, { PI_REVIEWER_BACKEND: 'jev', PI_REVIEWER_PROVIDER: 'openrouter', PI_REVIEWER_MODEL: 'typesafe/jev' });
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const key of keys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  const handlers = new Map<string, any>();
  const events: any[] = [];
  const notifications: string[] = [];
  extension({ on: (name: string, handler: any) => handlers.set(name, handler),
    appendEntry: (type: string, data: unknown) => manager.appendCustomEntry(type, data),
    events: { emit: (name: string, data: unknown) => events.push({ name, data }) },
  } as any);
  const ctx: any = { cwd, hasUI: true, sessionManager: manager, isProjectTrusted: () => false,
    modelRegistry: { getApiKeyForProvider: async () => 'saved-key' },
    ui: { notify: (message: string) => notifications.push(message), setStatus() {},
      select: () => { throw new Error('Unexpected approval prompt'); } },
  };
  handlers.get('session_start')({}, ctx);
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://openrouter.ai/api/alpha/decisions');
    assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer saved-key');
    calls++;
    return Response.json({ id: `gen-attempt-${calls}`, model: 'typesafe/jev', usage: { cost: calls === 1 ? 0.003 : 0.007 },
      answers: calls === 1 ? {} : { command_review: { type: 'choice', choice: 'allow', confidence: 0.9, probabilities: { allow: 0.9, block: 0.1 } } } });
  };
  assert.equal(await handlers.get('tool_call')({ toolName: 'bash', toolCallId: 'review-1', input: { command: 'npm test' } }, ctx), undefined);
  assert.equal(calls, 2);
  const billed = manager.getEntries().filter(e => e.type === 'usage');
  assert.equal(billed.length, 2);
  assert.ok(Math.abs(billed.reduce((sum, e) => sum + e.usage.cost.total, 0) - 0.01) < 1e-12);
  assert.ok(billed.every(e => e.usage.totalTokens === 0 && e.provider === 'openrouter'));
  assert.ok(notifications.some(message => message.includes('Auto-reviewer: ✓') && message.includes('OpenRouter $0.010000')));
  assert.equal(events.filter(e => e.name === 'pi-auto-reviewer:cost' && e.data.status === 'confirmed').length, 2);
  assert.equal(SessionManager.open(manager.getSessionFile()!).getEntries().filter(e => e.type === 'usage').length, 2);
  await handlers.get('session_shutdown')({}, ctx);
});
