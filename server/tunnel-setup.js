#!/usr/bin/env node
// One-time setup for a fixed address on a domain you manage in Cloudflare:
//   npm run tunnel:setup -- movies.example.com
// After this, `npm run online` always uses https://movies.example.com.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTALL_HINT } from './tunnel.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch {}
const hostname = (process.argv[2] || '').toLowerCase();
const NAME = process.env.TUNNEL_NAME || 'villavision';
const PORT = Number(process.env.PORT) || 4747;
const home = path.join(os.homedir(), '.cloudflared');

if (!/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(hostname)) {
  console.error('Usage: npm run tunnel:setup -- movies.example.com\n(the domain must be one you manage in your Cloudflare account)');
  process.exit(1);
}
if (spawnSync('cloudflared', ['--version']).error) { console.error(INSTALL_HINT); process.exit(1); }
const cf = (args, opts = {}) => execFileSync('cloudflared', args, { stdio: ['ignore', 'pipe', 'inherit'], ...opts }).toString();

if (!fs.existsSync(path.join(home, 'cert.pem'))) {
  console.log('Step 1/3: Sign in to Cloudflare. A browser window opens: pick the domain and approve.');
  spawnSync('cloudflared', ['tunnel', 'login'], { stdio: 'inherit' });
  if (!fs.existsSync(path.join(home, 'cert.pem'))) { console.error('Sign-in was not completed.'); process.exit(1); }
} else console.log('Step 1/3: Already signed in to Cloudflare.');

const find = () => JSON.parse(cf(['tunnel', 'list', '--output', 'json', '--name', NAME]) || '[]')?.find((t) => t.name === NAME && !t.deleted_at);
let tunnel = find();
if (tunnel && !fs.existsSync(path.join(home, `${tunnel.id}.json`))) {
  console.error(`A tunnel named "${NAME}" exists in your account, but its credentials are not on this computer.\nSet TUNNEL_NAME in .env to a different name and run this again.`);
  process.exit(1);
}
if (!tunnel) { console.log(`Step 2/3: Creating the tunnel "${NAME}".`); cf(['tunnel', 'create', NAME]); tunnel = find(); }
else console.log(`Step 2/3: Using the existing tunnel "${NAME}".`);

console.log(`Step 3/3: Pointing ${hostname} at the tunnel.`);
try { cf(['tunnel', 'route', 'dns', NAME, hostname]); }
catch { console.error(`Could not create the DNS record. If ${hostname} already exists in your DNS, remove that record or choose another name.`); process.exit(1); }

fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'data', 'cloudflared.yml'), [
  `tunnel: ${tunnel.id}`,
  `credentials-file: ${path.join(home, `${tunnel.id}.json`)}`,
  'ingress:',
  `  - hostname: ${hostname}`,
  `    service: http://127.0.0.1:${PORT}`,
  '  - service: http_status:404',
  '',
].join('\n'));

const envFile = path.join(ROOT, '.env');
const lines = (fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8').split('\n') : []).filter((l) => !/^PUBLIC_URL=/.test(l) && l !== '');
lines.push(`PUBLIC_URL=https://${hostname}`);
fs.writeFileSync(envFile, lines.join('\n') + '\n', { mode: 0o600 });

console.log(`\nDone. Run "npm run online" and your theatre is at https://${hostname}\n(a brand-new address can take a minute to start working)`);
