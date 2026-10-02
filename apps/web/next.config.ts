import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server output for the Docker image.
  output: "standalone",
  // The monorepo root, so file tracing includes workspace dependencies.
  outputFileTracingRoot: path.resolve(process.cwd(), "../.."),
  // The app used to have more screens. Old links and bookmarks land on their new home (query strings are kept,
  // which matters for the Google/Meta sign-in return trip).
  async redirects() {
    return [
      { source: "/connections", destination: "/settings", permanent: false },
      { source: "/company", destination: "/settings", permanent: false },
      { source: "/schedules", destination: "/settings", permanent: false },
      { source: "/approvals", destination: "/campaigns", permanent: false },
      { source: "/tasks", destination: "/", permanent: false },
      { source: "/activity", destination: "/", permanent: false },
      { source: "/audit", destination: "/", permanent: false },
    ];
  },
};

export default nextConfig;
