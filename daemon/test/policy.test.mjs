import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyPolicy, clearDecision, DECISION_TTL_MS, knownGroups, readDecision, readPolicy,
  requestDecision, resetPolicyState, statePaths, watchPolicy, writePolicy,
} from '../src/policy.mjs';

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailink-policy-'));
  process.env.TAILINK_STATE_DIR = dir;
  resetPolicyState();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.TAILINK_STATE_DIR;
});

function applyCtx() {
  const events = [];
  const sets = [];
  const factories = Object.fromEntries(knownGroups().map((g) => [g, () => null]));
  return {
    events,
    sets,
    manager: {
      name: 'idle',
      params: {},
      factories,
      set(name, params) {
        this.name = name;
        this.params = params;
        sets.push({ name, params });
      },
    },
    event(type, data) { events.push({ type, data }); },
  };
}

async function waitFor(fn, timeoutMs = 2000) {
  const until = Date.now() + timeoutMs;
  while (!fn() && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(fn(), 'timed out waiting for condition');
}

test('readPolicy returns a legal policy and null when missing', () => {
  assert.equal(readPolicy(), null);

  const written = writePolicy({ group: 'gather', params: { dir: 'right' }, reason: 'test' });
  assert.deepEqual(written, { group: 'gather', params: { dir: 'right' }, reason: 'test' });

  const policy = readPolicy();
  assert.deepEqual(policy, { group: 'gather', params: { dir: 'right' }, reason: 'test' });
  assert.ok(knownGroups().includes(policy.group));
});

test('readPolicy rejects unknown groups and applyPolicy emits policy_rejected', () => {
  fs.mkdirSync(statePaths().dir, { recursive: true });
  fs.writeFileSync(statePaths().policy, JSON.stringify({ group: 'not_a_real_group' }), 'utf8');

  const policy = readPolicy();
  assert.ok(policy.error);
  assert.match(policy.error, /unknown group/);

  const ctx = applyCtx();
  assert.equal(applyPolicy(ctx, policy, 'file'), false);
  assert.equal(ctx.sets.length, 0);
  assert.equal(ctx.events.length, 1);
  assert.equal(ctx.events[0].type, 'policy_rejected');
  assert.match(ctx.events[0].data.error, /unknown group/);
  assert.equal(ctx.events[0].data.source, 'file');
});

test('readPolicy reports invalid JSON instead of throwing', () => {
  fs.mkdirSync(statePaths().dir, { recursive: true });
  fs.writeFileSync(statePaths().policy, '{ not json', 'utf8');
  const policy = readPolicy();
  assert.ok(policy.error);
  assert.match(policy.error, /invalid json/);
});

test('writePolicy is atomic: replace works and no .tmp files are left behind', () => {
  writePolicy({ group: 'gather' });
  writePolicy({ group: 'explore', params: { dir: 'left' }, reason: 'second' });

  assert.equal(readPolicy().group, 'explore');
  const leftovers = fs.readdirSync(statePaths().dir).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
  const raw = JSON.parse(fs.readFileSync(statePaths().policy, 'utf8'));
  assert.equal(raw.group, 'explore');
  assert.deepEqual(raw.params, { dir: 'left' });
});

test('requestDecision writes timeout field and clearDecision removes it', () => {
  const ctx = applyCtx();
  const decision = requestDecision(ctx, {
    kind: 'goal_done',
    options: ['gather', 'explore', 'not_a_group'],
    defaultGroup: 'gather',
    summary: 'hp 40 · mode gather',
  });
  assert.ok(decision);

  const onDisk = readDecision();
  assert.equal(onDisk.seq, decision.seq);
  assert.equal(onDisk.kind, 'goal_done');
  assert.equal(onDisk.summary, 'hp 40 · mode gather');
  assert.deepEqual(onDisk.options, ['gather', 'explore']);
  assert.equal(onDisk.default, 'gather');
  assert.equal(onDisk.expiresAt - onDisk.at, DECISION_TTL_MS);
  assert.equal(DECISION_TTL_MS, 90_000);
  assert.equal(ctx.decision, decision);

  assert.equal(clearDecision(), true);
  assert.equal(readDecision(), null);
  assert.equal(clearDecision(), false);
});

test('requestDecision throttles the same kind for 5s but allows another kind', () => {
  const ctx = applyCtx();
  const first = requestDecision(ctx, { kind: 'goal_done', options: ['gather'], defaultGroup: 'gather' });
  assert.ok(first);

  const duplicate = requestDecision(ctx, { kind: 'goal_done', options: ['explore'], defaultGroup: 'explore' });
  assert.equal(duplicate, null);
  assert.equal(readDecision().seq, first.seq, 'file is not rewritten while throttled');
  assert.equal(readDecision().default, 'gather');

  const other = requestDecision(ctx, { kind: 'stuck', options: ['idle'], defaultGroup: 'idle' });
  assert.ok(other);
  assert.equal(other.seq, first.seq + 1);
  assert.equal(readDecision().kind, 'stuck');

  const log = fs.readFileSync(statePaths().decisionsLog, 'utf8').trim().split('\n');
  assert.equal(log.length, 1);
  assert.equal(JSON.parse(log[0]).seq, first.seq);
});

test('watchPolicy reacts to file changes and stops cleanly', async () => {
  const calls = [];
  const stop = watchPolicy((policy) => calls.push(policy), 10);
  try {
    writePolicy({ group: 'gather', params: { dir: 'left' } });
    await waitFor(() => calls.length === 1);
    assert.equal(calls[0].group, 'gather');
    assert.deepEqual(calls[0].params, { dir: 'left' });

    writePolicy({ group: 'bogus_group' });
    await waitFor(() => calls.length === 2);
    assert.ok(calls[1].error);
  } finally {
    stop();
  }

  // stop 之后写文件不应再回调。
  writePolicy({ group: 'explore' });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(calls.length, 2);
});

test('applyPolicy applies a valid group and records memory state', () => {
  const ctx = applyCtx();
  const ok = applyPolicy(ctx, { group: 'hold', params: { range: 12 }, reason: 'test' }, 'file');
  assert.equal(ok, true);
  assert.deepEqual(ctx.sets, [{ name: 'hold', params: { range: 12 } }]);
  assert.equal(ctx.policy.group, 'hold');
  assert.equal(ctx.policy.source, 'file');
  assert.equal(ctx.policy.reason, 'test');
  assert.equal(ctx.events.at(-1).type, 'policy_applied');
  assert.deepEqual(ctx.events.at(-1).data, {
    group: 'hold', params: { range: 12 }, source: 'file', reason: 'test',
  });
});
