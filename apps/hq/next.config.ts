import type { NextConfig } from 'next';

const target = process.env.HQ_TARGET === 'desktop' ? 'desktop' : 'web';

/**
 * The desktop list, and the web list with `web.ts`/`web.tsx` in front of it.
 *
 * Next builds its route-leaf matcher from these extensions
 * (`(^route|[\\/]route)\.(?:<pageExtensions>)$`), so a file named
 * `route.web.ts` is a route leaf in the web build and, in the desktop build,
 * matches no leaf pattern at all: not a route, not in the graph, not in the
 * bundle -- while `tsc` and `eslint` still read it, because they go by the
 * tsconfig `include`, not by Next's matcher.
 *
 * That is what lets `app/api/[[...rpc]]/route.web.ts` exist in a repository
 * whose desktop target is `output: 'export'`. A static export refuses a
 * dynamic route handler outright, demanding `generateStaticParams()` -- which
 * an RPC endpoint cannot have, because its paths are the service's methods.
 */
const pageExtensions =
  target === 'desktop'
    ? ['tsx', 'ts', 'jsx', 'js']
    : ['web.ts', 'web.tsx', 'tsx', 'ts', 'jsx', 'js'];

const nextConfig: NextConfig = {
  reactCompiler: true,
  experimental: {
    cpus: 2,
    // `lucide-react` and `@tabler/icons-react` are already in Next's own
    // default list; `@hugeicons/core-free-icons` is the one adapter
    // (`packages/ui/src/icons/hugeicons.ts`) that imports its icons by name
    // from that package's barrel rather than by a per-icon path, and is not.
    optimizePackageImports: ['@hugeicons/core-free-icons'],
  },
  pageExtensions,
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
