import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker image (Dockerfile sets
  // BUILD_STANDALONE=1). Local builds keep the default output so that
  // `next start` (used by `npm run test:ui`) keeps working on Windows.
  output: process.env.BUILD_STANDALONE === "1" ? "standalone" : undefined,
  // Next.js 16 template default. The code follows its rules: API routes call
  // connection() to run per request, and client components never read the
  // clock during render, so "/" is prerendered as a static shell.
  cacheComponents: true,
  // Required alongside cacheComponents in Next.js 16.4 (the build warns
  // without it). It only changes how <Link> prefetches; this single-page app
  // has no <Link>, so it has no runtime effect here.
  partialPrefetching: true,
  // Tailwind CSS v4 through Turbopack (there is no PostCSS config).
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
