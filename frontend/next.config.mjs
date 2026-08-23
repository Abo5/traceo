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

  // `next dev` treats a request for its /_next/* dev assets from an origin other
  // than localhost as cross-origin and refuses it. That makes the app served to
  // another machine on the LAN load its HTML but none of its JavaScript — a blank
  // or unstyled page whose failure never mentions origins, so it looks like a
  // build problem rather than a policy one. These entries are the LAN spellings
  // of this host; they affect the dev server ONLY and have no bearing on a
  // production build.
  allowedDevOrigins: [
    "192.168.100.202",
    "panda.local",
  ],
};

export default nextConfig;
