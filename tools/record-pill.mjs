// Records the pill's own page — never the screen behind it — for the README
// demo. Chromium's screencast over the DevTools port, so the recording holds
// only what BotWatch draws.
//
//   node --experimental-websocket tools/record-pill.mjs <out-dir> [modeFile]
//
// Start BotWatch with --remote-debugging-port=9222 first. Recording stops on
// SIGINT or SIGTERM and then encodes <out-dir>/demo.mp4 and demo.gif.
//
// While recording, <modeFile> can say "ff": frames in that stretch play 8x
// faster (workers busy, nothing to watch). Anything else plays at real speed,
// so the wheel and the flashes keep their real timing.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [outDir, modeFile] = process.argv.slice(2);
if (!outDir) {
  console.error('usage: record-pill.mjs <out-dir> [modeFile]');
  process.exit(2);
}
const framesDir = join(outDir, 'frames');
mkdirSync(framesDir, { recursive: true });

const FF_SPEED = 8;
const MAX_HOLD = 1.0; // no frame is held longer than this, even at real speed

const pages = await (await fetch('http://localhost:9222/json/list')).json();
const page = pages.find((p) => p.type === 'page' && p.url.startsWith('app://pill'));
if (!page) throw new Error('no BotWatch page on :9222');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));

let nextId = 1;
const send = (method, params = {}) => ws.send(JSON.stringify({ id: nextId++, method, params }));

// A plain backdrop for the transparent overlay, only while recording.
send('Runtime.evaluate', {
  expression: `(() => { const s = document.createElement('style'); s.id = 'rec-bg';
    s.textContent = 'html, body { background: linear-gradient(180deg, #f6f7f9, #e7e9ed) !important; }';
    document.head.append(s); })()`,
});

const frames = [];
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.method !== 'Page.screencastFrame') return;
  const { data, metadata, sessionId } = msg.params;
  const file = join(framesDir, `${String(frames.length).padStart(6, '0')}.png`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  const mode = modeFile && existsSync(modeFile) ? readFileSync(modeFile, 'utf8').trim() : 'normal';
  frames.push({ file, t: metadata.timestamp, mode });
  send('Page.screencastFrameAck', { sessionId });
});

send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
console.log(`recording ${page.url} -> ${outDir}`);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  send('Page.stopScreencast');
  send('Runtime.evaluate', { expression: `document.getElementById('rec-bg')?.remove()` });
  await new Promise((r) => setTimeout(r, 300));
  ws.close();
  encode();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

function encode() {
  if (frames.length < 2) {
    console.error('not enough frames');
    return;
  }
  // Each frame is held until the next, scaled by its mode and capped.
  const lines = [];
  let total = 0;
  for (let i = 0; i < frames.length; i += 1) {
    const f = frames[i];
    const next = frames[i + 1];
    let hold = next ? next.t - f.t : 0.5;
    if (f.mode === 'ff') hold /= FF_SPEED;
    hold = Math.max(0.001, Math.min(MAX_HOLD, hold));
    total += hold;
    lines.push(`file '${f.file}'`, `duration ${hold.toFixed(4)}`);
  }
  lines.push(`file '${frames.at(-1).file}'`);
  const list = join(outDir, 'frames.txt');
  writeFileSync(list, `${lines.join('\n')}\n`);
  console.log(`${frames.length} frames, ${total.toFixed(1)}s after speed-up`);

  const mp4 = join(outDir, 'demo.mp4');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list,
    '-vf', 'fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', mp4]);
  const gif = join(outDir, 'demo.gif');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp4, '-vf',
    'fps=15,scale=900:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4', gif]);
  console.log(`wrote ${mp4} and ${gif}`);
}
