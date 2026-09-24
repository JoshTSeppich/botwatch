#!/usr/bin/env node
// The MCP server attached to the orchestrator session, and only to it.
//
// It holds nothing. Each tool call is relayed to pilld over its control
// socket, where the run lives beside the pill — so the model and the user act
// on the same run, and every call still goes through run.js and policy.js.
// If BotWatch is not running, every tool says so.
//
// Plain JSON-RPC over stdio. An SDK would be a dependency for about sixty lines
// of framing.

import { createInterface } from 'node:readline';

import { CONTROL_PATH, controlClient } from './control.js';
import { TOOLS } from './tools.js';

// With BotWatch gone the run is gone, and a relay with nothing to relay to
// must not outlive it. Nor must it outlive the session that started it.
// The short delay lets the error for a call already in flight go out first.
const client = controlClient(process.env.BOTWATCH_CONTROL_SOCK || CONTROL_PATH, process.env.BOTWATCH_RUN_TOKEN ?? '', () =>
  setTimeout(() => process.exit(0), 200),
);

function schema(params) {
  const properties = {};
  for (const [name, type] of Object.entries(params)) properties[name] = { type };
  return { type: 'object', properties, required: Object.keys(params).slice(0, 1) };
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

createInterface({ input: process.stdin }).on('close', () => process.exit(0)).on('line', async (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = request;

  if (method === 'initialize') {
    return send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'botwatch', version: '0.1.0' },
      },
    });
  }
  if (method === 'tools/list') {
    return send({
      jsonrpc: '2.0',
      id,
      result: {
        tools: TOOLS.map(([name, description, params]) => ({
          name,
          description,
          inputSchema: schema(params),
        })),
      },
    });
  }
  if (method === 'tools/call') {
    const result = await client.call(params?.name, params?.arguments ?? {});
    return send({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: JSON.stringify(result) }] },
    });
  }
  if (id != null) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
});
