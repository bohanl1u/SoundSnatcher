// Checks that the external binaries SoundSnatcher shells out to are present.
//   npm run doctor

import { spawn } from 'node:child_process';
import { FFMPEG, YTDLP } from '../lib/media.js';

function version(cmd, args) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve(null);
      return;
    }
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? out.trim().split('\n')[0] : null));
  });
}

const checks = [
  { name: 'yt-dlp', cmd: YTDLP, args: ['--version'], install: 'brew install yt-dlp' },
  { name: 'ffmpeg', cmd: FFMPEG, args: ['-version'], install: 'brew install ffmpeg' },
];

let missing = 0;
for (const check of checks) {
  const found = await version(check.cmd, check.args);
  if (found) {
    console.log(`  ok    ${check.name.padEnd(8)} ${found}`);
  } else {
    missing++;
    console.log(`  MISS  ${check.name.padEnd(8)} not found — install with: ${check.install}`);
  }
}

console.log(`\nnode      ${process.version}`);
console.log(missing ? `\n${missing} dependency missing.` : '\nAll good. Run: npm start');
process.exit(missing ? 1 : 0);
