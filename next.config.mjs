import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const nextConfig = {
  turbopack: {
    root: dirname(fileURLToPath(import.meta.url)),
  },
  // firebase-admin must never be bundled — it is a Node-native package with
  // dynamic requires. It is ALREADY in Next 16's built-in external list, so
  // this line is belt-and-braces and was measured to be a NO-OP: adding it
  // produced a byte-identical build. It is kept only to pin the behaviour if
  // that built-in list ever changes.
  //
  // BE CLEAR: this is NOT what fixed the Vercel 500. That fix is the
  // `--webpack` build flag in package.json — see the DEVLOG entry.
  serverExternalPackages: ["firebase-admin"],
};

export default nextConfig;
