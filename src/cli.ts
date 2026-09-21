#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';
import { loadConfig } from './config.js';
import { createNodeServer } from './server.js';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: logjev [--config path/to/config.yaml]\nEnvironment: PORT, HOST, LOGJEV_ACTIVE, PROMPT_MODE, BRIDGE_API_KEY\nCopy config.example.yaml to config.yaml; put upstream keys in .env.');
} else {
  try {
    const at = args.indexOf('--config');
    if (args.length && (at !== 0 || args.length !== 2)) throw new Error('Use logjev --help for supported arguments');
    const configPath = resolve(at === 0 ? args[1] : 'config.yaml');
    const envPath = resolve(dirname(configPath), '.env');
    if (existsSync(envPath)) loadEnvFile(envPath);
    const config = loadConfig(configPath);
    const demosDirectory = fileURLToPath(new URL('../demos/', import.meta.url));
    const server = createNodeServer(config, { demosDirectory });
    server.on('error', error => { console.error(`LogJev could not start: ${error.message}`); process.exitCode = 1; });
    server.listen(config.port, config.host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : config.port;
      console.log(`LogJev: http://${config.host}:${port} · provider ${config.active}`);
      console.log(`Demos: http://${config.host}:${port}/demos/`);
    });
    const shutdown = () => { server.close(); server.closeIdleConnections(); };
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  } catch (error) { console.error(error instanceof Error ? error.message : 'LogJev could not start'); process.exitCode = 1; }
}
