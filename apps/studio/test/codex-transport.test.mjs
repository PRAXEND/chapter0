import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { CodexClient } from '../src/codex.mjs';

function transport(handle) {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const send = (msg) => child.stdout.write(JSON.stringify(msg) + '\n');
  child.kill = () => {
    child.stdin.end();
    child.stdout.end();
    child.stderr.end();
    child.emit('exit', 0);
  };
  createInterface({ input: child.stdin }).on('line', (line) => {
    const msg = JSON.parse(line);
    if (!msg.method || msg.method === 'initialized') {
      handle(msg, send);
      return;
    }
    if (msg.method === 'initialize') {
      send({ id: msg.id, result: {} });
      return;
    }
    if (msg.method === 'config/read') {
      send({ id: msg.id, result: { config: { mcp_servers: { other_connector: { enabled: true } } } } });
      return;
    }
    handle(msg, send);
  });
  return child;
}

test('official RPC uses a durable isolated thread and binds server tool requests to its current turn', async (t) => {
  const called = [];
  let declined = false;
  const c = new CodexClient({
    launch: async (args) => {
      assert.ok(args.includes('features.shell_tool=false'));
      return transport((m, send) => {
        if (m.method === 'thread/start' || m.method === 'thread/resume') {
          assert.equal(m.params.config['mcp_servers.other_connector.enabled'], false);
          assert.equal(m.params.permissions, 'video_studio_editor');
          if (m.method === 'thread/start') {
            assert.equal(m.params.ephemeral, false);
            assert.deepEqual(m.params.environments, []);
          }
          send({ id: m.id, result: { thread: { id: 'project-thread' } } });
          return;
        }
        if (m.method === 'mcpServerStatus/list') {
          send({ id: m.id, result: { data: [], nextCursor: null } });
          return;
        }
        if (m.method === 'turn/start') {
          assert.deepEqual(m.params.environments, []);
          send({ id: m.id, result: { turn: { id: 'current' } } });
          send({ method: 'turn/started', params: { threadId: 'project-thread', turn: { id: 'current' } } });
          send({
            method: 'item/tool/call',
            id: 999,
            params: { threadId: 'project-thread', turnId: 'unrelated', tool: 'studio_edit' },
          });
          send({
            method: 'item/tool/call',
            id: 1000,
            params: { threadId: 'project-thread', turnId: 'current', tool: 'studio_context' },
          });
          return;
        }
        if (m.id === 999) {
          declined = Boolean(m.error);
          return;
        }
        if (m.id === 1000) {
          assert.equal(m.result.success, true);
          send({
            method: 'item/completed',
            params: {
              threadId: 'project-thread',
              turnId: 'current',
              item: { type: 'agentMessage', text: '完成' },
            },
          });
          send({
            method: 'turn/completed',
            params: { threadId: 'project-thread', turn: { id: 'current', status: 'completed' } },
          });
        }
      });
    },
  });
  t.after(() => c.close());
  const id = await c.thread(null, [], 'edit only', {});
  const res = await c.runTurn({
    threadId: id,
    prompt: 'test',
    tool: async (msg) => {
      called.push(msg.tool);
      return { success: true, contentItems: [] };
    },
  });
  assert.equal(res, '完成');
  assert.deepEqual(called, ['studio_context']);
  assert.ok(declined);
  assert.equal(await c.thread(id, [], 'edit only', {}), id);
});

test('an unexpected third-party connector blocks before any project data goes to a model turn', async (t) => {
  const c = new CodexClient({
    launch: async () =>
      transport((m, send) => {
        if (m.method === 'thread/start') send({ id: m.id, result: { thread: { id: 'thread' } } });
        if (m.method === 'mcpServerStatus/list')
          send({ id: m.id, result: { data: [{ tools: { other: {} } }], nextCursor: null } });
        if (m.method === 'turn/start') assert.fail('unexpected model turn');
      }),
  });
  t.after(() => c.close());
  await assert.rejects(c.thread(null, [], 'edit only', {}), /工程以外/);
});

test('restart reconnects to the exact live turn without submitting a second turn', async (t) => {
  let starts = 0,
    calls = 0;
  const c = new CodexClient({
    launch: async () =>
      transport((m, send) => {
        if (m.method === 'turn/start') {
          starts++;
          return;
        }
        if (m.method === 'thread/read') {
          send({ id: m.id, result: { thread: { status: { type: 'active' } } } });
          return;
        }
        if (m.method === 'thread/turns/list') {
          send({
            id: m.id,
            result: { data: [{ id: 'existing', status: 'inProgress', items: [] }], nextCursor: null },
          });
          setImmediate(() =>
            send({
              method: 'item/tool/call',
              id: 800,
              params: { threadId: 'project', turnId: 'existing', tool: 'studio_context' },
            })
          );
        }
        if (m.id === 800) {
          send({
            method: 'item/completed',
            params: { threadId: 'project', turnId: 'existing', item: { type: 'agentMessage', text: '已恢复' } },
          });
          send({
            method: 'turn/completed',
            params: { threadId: 'project', turn: { id: 'existing', status: 'completed' } },
          });
        }
      }),
  });
  t.after(() => c.close());
  await c.connect();
  const message = await c.runTurn({
    threadId: 'project',
    existingTurnId: 'existing',
    tool: async () => {
      calls++;
      return { success: true, contentItems: [] };
    },
  });
  assert.equal(message, '已恢复');
  assert.equal(starts, 0);
  assert.equal(calls, 1);
});

test('steer sends expectedTurnId with the new text and never creates another model turn', async (t) => {
  const accepted = [];
  let starts = 0;
  const ready = Promise.withResolvers();
  const c = new CodexClient({
    launch: async () =>
      transport((m, send) => {
        if (m.method === 'turn/start') {
          starts++;
          send({ id: m.id, result: { turn: { id: 'active' } } });
          return;
        }
        if (m.method === 'turn/steer') {
          accepted.push(m.params);
          send({ id: m.id, result: { turnId: m.params.expectedTurnId } });
          send({
            method: 'turn/completed',
            params: { threadId: 'project', turn: { id: 'active', status: 'completed' } },
          });
        }
      }),
  });
  t.after(() => c.close());
  await c.connect();
  const running = c.runTurn({
    threadId: 'project',
    prompt: 'first',
    tool: () => {},
    onStart: (id) => ready.resolve(id),
  });
  const id = await ready.promise;
  await assert.rejects(c.steer('project', 'old', 'wrong'), (e) => e.status === 409);
  assert.deepEqual(await c.steer('project', id, 'next'), { turnId: id });
  await running;
  assert.equal(starts, 1);
  assert.deepEqual(accepted, [
    { threadId: 'project', expectedTurnId: 'active', input: [{ type: 'text', text: 'next' }] },
  ]);
});
