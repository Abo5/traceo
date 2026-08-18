import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Emits .next/standalone with only the files the server actually needs, so the
  // container image carries neither node_modules nor the build toolchain
  // (FR-081). No effect on `next dev`.
  output: "standalone",

  // Without this, Next infers the workspace root by walking up for lockfiles and
  // can land outside the repo (a stray ~/package-lock.json is enough). It then
  // nests the bundle as .next/standalone/<inferred>/<path>/server.js, which
  // silently breaks the Dockerfile's COPY. Pinning it to this directory keeps
  // server.js at .next/standalone/server.js on every machine.
  outputFileTracingRoot: here,
};

export default nextConfig;
