// Explicit integration fixture: real DSH Gateway -> HTTP core -> SQLite.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access';
import Gateway from '@deepseek-ai/dsh-api-gateway';
import { Peer } from '@deepseek-ai/dsh-client-connection';
import { installGateway } from '../.compiled/gateway.js';
import { CoreClient } from '../.compiled/transport.js';
import { Reply } from '../.compiled/contracts.js';

const [url, credentials] = process.argv.slice(2);
if (!url || !credentials) throw new Error('Usage: node scripts/smoke-core.mjs <loopback URL> <test credentials file>');
const client = new CoreClient(url, credentials);
const ctx = new Context();
const prefix = 'integration-' + randomUUID();
const wid = prefix + ':workspace';
const a = prefix + ':a', b = prefix + ':b', outside = prefix + ':outside';
const results = [];
try {
  await ctx.plugin(TypertRegistry); await ctx.plugin(RemoteAccess); await ctx.plugin(Gateway);
  await installGateway(ctx, async (request, signal) => Reply.parse({ result: await client.call('admin', request, signal) }));
  const peer = new Peer(ctx, { principal: { kind: 'owner' } });
  const admin = async (operation, payload = {}, session_id = a) => (await ctx.typertGateway.invoke({ peer, namespace: 'memoryFramework', method: 'command', args: { request: { operation, payload, session_id } } })).result;
  for (const id of [wid, wid + '-private']) await client.call('host', { operation: 'workspace.upsert', payload: { id, name: 'Integration fixture', path: '/' + id, instance_id: prefix } });
  for (const id of [a, b, outside]) await client.call('host', { operation: 'session.upsert', payload: { id, workspace_id: id === outside ? wid + '-private' : wid } });
  const task = await admin('task.create', { workspace_id: wid, title: 'Gateway smoke', goal: 'Verify two windows', acceptance: ['Verified externally'] });
  for (const id of [a,b]) await admin('session.bind', { session_id: id, task_id: task.id, expected_task_id: null });
  await client.call('host', { operation: 'event.ingest', payload: { session_id: a, sequence: 1, event_id: 'event-1', role: 'user', content: 'Canonical SQLite constraint for integration' } });
  const search = (sid) => client.call('model', { operation: 'memory.search', session_id: sid, payload: { query: 'Canonical SQLite' } });
  assert((await search(b)).results.some(m => m.workspace_id === wid)); results.push('cross-session task memory');
  assert(!(await search(outside)).results.some(m => m.workspace_id === wid)); results.push('workspace isolation');
  const writes = await Promise.allSettled([a,b].map(sid => client.call('model', { operation: 'task.update', session_id: sid, payload: { id: task.id, expected_revision: 1, next_action: sid } })));
  assert.equal(writes.filter(r => r.status === 'fulfilled').length, 1); results.push('concurrent revision conflict');
  const current = await client.call('model', { operation: 'task.read', session_id: b, payload: {} });
  await assert.rejects(client.call('model', { operation: 'task.update', session_id: b, payload: { id: task.id, expected_revision: current.revision, status: 'completed' } }), { code: 'verification_required' }); results.push('unsupported completion rejected');
  const m = (await search(b)).results.find(m => m.workspace_id === wid);
  await admin('source.revoke', { id: m.source_ids[0], expected_revision: 1 });
  assert.equal((await client.call('host', { operation: 'context.check', session_id: b, payload: {} })).safe, false); results.push('revocation fences exposed window');
  console.log(JSON.stringify({ status: 'passed', checks: results, count: results.length, transport: 'real DSH Gateway + CoreClient + FastAPI + SQLite' }, null, 2));
} finally { await ctx.fiber.dispose(); }
