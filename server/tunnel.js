// Puts the theatre online with a Cloudflare Tunnel: an outbound, encrypted
// connection from this computer, so no router ports are opened.
//  - No setup: a temporary https://….trycloudflare.com address, new each run.
//  - After `npm run tunnel:setup -- movies.example.com`: your own fixed address.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const INSTALL_HINT = `cloudflared is not installed. It is the free tool that puts the theatre online.
    macOS:   brew install cloudflared
    Windows: winget install --id Cloudflare.cloudflared
    Linux:   https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/`;

export function startTunnel({ root, port, onUrl }) {
  const config = path.join(root, 'data', 'cloudflared.yml');
  const named = fs.existsSync(config) && process.env.PUBLIC_URL;
  const args = named
    ? ['tunnel', '--no-autoupdate', '--config', config, 'run']
    : ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`];
  const child = spawn('cloudflared', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let announced = false, tail = '';
  child.on('error', (e) => console.error(e.code === 'ENOENT' ? `\n  ! ${INSTALL_HINT}\n` : `\n  ! Tunnel error: ${e.message}\n`));
  child.stderr.on('data', (d) => {
    tail = (tail + d).slice(-2000);
    if (announced) return;
    if (named) {
      if (/Registered tunnel connection/.test(tail)) { announced = true; onUrl(process.env.PUBLIC_URL.replace(/\/+$/, '')); }
    } else {
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(tail);
      if (m) { announced = true; onUrl(m[0]); }
    }
  });
  child.on('exit', (code) => { if (code) console.error(`\n  ! The tunnel stopped (code ${code}). Last output:\n${tail.split('\n').slice(-4).join('\n')}\n`); });
  return child;
}
