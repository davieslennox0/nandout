import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Self-contained server bundle: built in GitHub Actions, run on our own server with `node web/server.js`.
  output: 'standalone',
  experimental: { outputFileTracingRoot: root },
  transpilePackages: ['@latch/compiler'],
  webpack: (config) => {
    // wagmi's optional connectors pull these in; we only use the injected connector.
    config.externals.push('pino-pretty', 'lokijs', 'encoding');
    return config;
  },
};
export default nextConfig;
