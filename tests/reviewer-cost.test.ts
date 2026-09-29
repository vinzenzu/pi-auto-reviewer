import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReviewerCosts, ReviewerOutput, REVIEWER_COST_EVENT, formatReviewerCost } from '../reviewer-cost.ts';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test('reviewer exposes actual billing once per generation and uses the saved credential resolver', async () => {
  const events: any[] = [];
  let calls = 0;
  const costs = new ReviewerCosts({ parentSessionId: 'parent', reviewId: 'tool-1',
    getApiKey: async () => 'saved-key', report: event => events.push(event),
    fetch: async (url, options) => {
      calls++;
      assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer saved-key');
      return Response.json({ data: { id: new URL(String(url)).searchParams.get('id'), total_cost: 0.0030718 } });
    },
  });
  const message = { provider: 'openrouter', model: 'reviewer-model', responseId: 'gen-1' };
  costs.observe(message); costs.observe(message);
  await flush();
  assert.equal(calls, 1);
  assert.deepEqual(events.map(event => event.status), ['pending', 'confirmed']);
  assert.equal(events[1].costUSD, 0.0030718);
  assert.equal(events[1].parentSessionId, 'parent');
  assert.equal(REVIEWER_COST_EVENT, 'pi-auto-reviewer:cost');
  assert.equal(formatReviewerCost(costs.summary()), 'OpenRouter $0.003072');
  costs.dispose();
});

test('zero bills and failed review attempts count; other providers are not called OpenRouter bills', async () => {
  const costs = new ReviewerCosts({ parentSessionId: 'parent', reviewId: 'tool-2', getApiKey: async () => 'key', report: () => {},
    fetch: async url => Response.json({ data: { id: new URL(String(url)).searchParams.get('id'), total_cost: 0 } }),
  });
  costs.observe({ provider: 'openrouter', responseId: 'failed-attempt', stopReason: 'error' });
  costs.observe({ provider: 'openrouter', responseId: 'retry-success' });
  costs.observe({ provider: 'another-provider', responseId: 'other' });
  await flush();
  assert.deepEqual(costs.summary(), { costUSD: 0, confirmed: 2, pending: 0, unavailable: 0 });
  costs.dispose();
});

test('missing IDs and credentials remain visibly unavailable', async () => {
  const costs = new ReviewerCosts({ parentSessionId: 'parent', reviewId: 'tool-3', getApiKey: async () => undefined, report: () => {} });
  costs.observe({ provider: 'openrouter', timestamp: 1 });
  costs.observe({ provider: 'openrouter', responseId: 'cannot-auth' });
  await flush();
  assert.equal(costs.summary().unavailable, 2);
  assert.match(formatReviewerCost(costs.summary()), /unavailable/);
  costs.dispose();
});

test('observer failures cannot change review decisions; unfinished subprocess IDs survive', () => {
  const ids: string[] = [];
  const parser = new ReviewerOutput(message => ids.push(message.responseId));
  const bytes = Buffer.from(JSON.stringify({ type: 'message_update', message: { role: 'assistant', provider: 'openrouter', responseId: 'unfinished', content: '€' } }) + '\n');
  for (const byte of bytes) parser.write(Buffer.from([byte]));
  assert.deepEqual(ids, []);
  parser.end();
  assert.deepEqual(ids, ['unfinished']);
  const failing = new ReviewerOutput(() => { throw new Error('observer'); });
  assert.doesNotThrow(() => { failing.write(bytes); failing.end(); });
});

test('late billing callbacks are cancelled when the session shuts down', async () => {
  let resolve!: (response: Response) => void;
  const events: any[] = [];
  const costs = new ReviewerCosts({ parentSessionId: 'parent', reviewId: 'tool-4', getApiKey: async () => 'key', report: event => events.push(event),
    fetch: () => new Promise(done => { resolve = done; }),
  });
  costs.observe({ provider: 'openrouter', responseId: 'late' });
  await flush();
  costs.dispose();
  resolve(Response.json({ data: { id: 'late', total_cost: 9 } }));
  await flush();
  assert.deepEqual(events.map(event => event.status), ['pending']);
});


test('Jev uses provider-reported cost without an extra lookup and keeps missing billing unavailable', () => {
  const events: any[] = [];
  const costs = new ReviewerCosts({ parentSessionId: 'parent', reviewId: 'jev-review', getApiKey: async () => 'key', report: event => events.push(event),
    fetch: async () => { throw new Error('Jev reported its charge already'); },
  });
  costs.observeCharge({ provider: 'openrouter', responseId: 'jev-1', model: 'typesafe/jev', costUSD: 0.000017 });
  costs.observeCharge({ provider: 'openrouter', responseId: 'jev-1', costUSD: 0.000017 });
  costs.observeCharge({ provider: 'openrouter', costUSD: 0 });
  costs.observeCharge({ provider: 'openrouter', costUSD: 'invalid' });
  assert.deepEqual(costs.summary(), { costUSD: 0.000017, confirmed: 2, pending: 0, unavailable: 1 });
  assert.equal(events.filter(e => e.status === 'confirmed').length, 2);
  costs.dispose();
});


test('billing labels name OpenRouter and never label another provider as OpenRouter', () => {
  assert.equal(formatReviewerCost({ costUSD: 0, confirmed: 0, pending: 1, unavailable: 1 }), 'OpenRouter cost · 1 pending · 1 unavailable');
  const events: unknown[] = [];
  const costs = new ReviewerCosts({ parentSessionId: 'parent', reviewId: 'other-provider', getApiKey: async () => { throw new Error('Must not resolve an OpenRouter key'); }, report: event => events.push(event) });
  costs.observe({ provider: 'anthropic', responseId: 'other-message' });
  costs.observeCharge({ provider: 'typesafe', responseId: 'other-decision', costUSD: 0.002 });
  assert.equal(formatReviewerCost(costs.summary()), '');
  assert.deepEqual(events, []);
  costs.dispose();
});
