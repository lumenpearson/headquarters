import type { NextConfig } from 'next'

const target = process.env.HQ_TARGET === 'desktop' ? 'desktop' : 'web';

const nextConfig: NextConfig = {
  reactCompiler: true,
  experimental: {
    cpus: 2,
  },
  ...(target === 'desktop'
    ? {
        output: 'export' as const,
        trailingSlash: true,
        images: { unoptimized: true },
      }
    : {}),
  transpilePackages: ['@gremuchaya/domain', '@gremuchaya/config', '@gremuchaya/ui'],
  productionBrowserSourceMaps: false,
  poweredByHeader: false,
};

export default nextConfig;
