import { createInterface } from 'node:readline';
import { music, validate } from './music.mjs';
import { lynx } from './lynx.mjs';

import { audio } from './audio.mjs';
import { live, settings } from './live.mjs';

const handlers = new Map(Object.entries({ ...lynx, ...music, ...live, ...audio }));
const tools = Array.from(handlers, ([name, [description, inputSchema]]) => ({ name, description, inputSchema }));

async function call(name, args) {
  const tool = handlers.get(name);
  if (!tool) throw new Error('Unknown tool: ' + name);
  const [, schema, execute] = tool;
  validate(args, schema);
  const state = await settings();
  if (name === 'lynx_status') return { ...(await execute(args)), mcp: state };
  if (!state.enabled) throw new Error('MCP tools are disabled in the LYNX MCP window.');
  return execute(args);
}
function reply(id, body) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...body }) + '\n');
}

async function receive(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    reply(null, { error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (request?.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    reply(request?.id ?? null, { error: { code: -32600, message: 'Invalid request' } });
    return;
  }
  if (!Object.hasOwn(request, 'id')) return;
  const { id, method, params } = request;
  if (method === 'initialize') {
    const supported = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
    const protocolVersion = supported.includes(params?.protocolVersion) ? params.protocolVersion : supported[0];
    reply(id, { result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'lynx-share', version: '1.0.1' } } });
  } else if (method === 'ping' || method === 'tools/list') {
    reply(id, { result: method === 'ping' ? {} : { tools } });
  } else if (method === 'tools/call') {
    try {
      const result = await call(params?.name, params?.arguments ?? {});
      reply(id, { result: result.content ? result : { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } });
    } catch (error) {
      reply(id, { result: { isError: true, content: [{ type: 'text', text: error.message }] } });
    }
  } else {
    reply(id, { error: { code: -32601, message: 'Method not found' } });
  }
}

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (line.trim()) void receive(line);
}
