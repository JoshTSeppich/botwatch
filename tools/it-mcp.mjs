// Integration: attach the MCP server to a real Claude session and check that
// the merge gate holds when a model is actually pushing on it.
//
//   node tools/it-mcp.mjs /path/to/a/git/repo
//
// Not part of `npm test`: it spends tokens and needs a logged-in CLI.
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const repo = process.argv[2];
const dir = mkdtempSync(join(tmpdir(), 'botwatch-it-'));
const config = join(dir, 'mcp.json');
const server = new URL('../electron/orchestrator/mcp.js', import.meta.url).pathname;

writeFileSync(
  config,
  JSON.stringify({
    mcpServers: {
      botwatch: {
        command: 'node',
        args: [server],
        env: { BOTWATCH_RUN: JSON.stringify({ repo, model: 'haiku', maxWorkers: 2, budgetTokens: 5_000_000 }) },
      },
    },
  }),
);

const prompt = JSON.stringify({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'text', text: 'Use botwatch merge_worktrees with order ["w1"]. If it refuses, report the exact error.' }],
  },
});

const { stdout } = await run(
  'sh',
  ['-c', `printf '%s\\n' '${prompt.replace(/'/g, "'\\''")}' | claude -p --output-format stream-json --input-format stream-json --verbose --model haiku --mcp-config ${config} --permission-mode bypassPermissions`],
  { cwd: repo, maxBuffer: 32 * 1024 * 1024 },
);

const refused = stdout.includes('merge needs the user to click Merge');
console.log('  merge gate held:', refused);
process.exit(refused ? 0 : 1);
