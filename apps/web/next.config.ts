import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server output for the Docker image.
  output: "standalone",
  // The monorepo root, so file tracing includes workspace dependencies.
  outputFileTracingRoot: path.resolve(process.cwd(), "../.."),
};

export default nextConfig;
