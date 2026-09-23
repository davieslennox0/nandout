/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@latch/compiler'],
  webpack: (config) => {
    // wagmi's optional connectors pull these in; we only use the injected connector.
    config.externals.push('pino-pretty', 'lokijs', 'encoding');
    return config;
  },
};
export default nextConfig;
