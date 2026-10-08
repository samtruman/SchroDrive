import fs from "node:fs";

type BuildManifest = {
  commit?: string;
  builtAt?: string;
  image?: string;
  runtimeCommit?: string;
  frontendCommit?: string;
};

function readManifest(): BuildManifest {
  const file = process.env.SCHRODRIVE_BUILD_INFO_FILE || "/config/validation-runtime/BUILD_INFO.json";
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as BuildManifest; } catch { return {}; }
}

export function getBuildInfo() {
  const manifest = readManifest();
  return {
    version: process.env.SCHRODRIVE_VERSION || "0.11.5",
    commit: process.env.SCHRODRIVE_BUILD_COMMIT || manifest.commit || "unknown",
    builtAt: process.env.SCHRODRIVE_BUILD_TIME || manifest.builtAt || null,
    image: process.env.SCHRODRIVE_IMAGE || manifest.image || null,
    runtimeCommit: process.env.SCHRODRIVE_RUNTIME_COMMIT || manifest.runtimeCommit || null,
    frontendCommit: process.env.SCHRODRIVE_FRONTEND_COMMIT || manifest.frontendCommit || null,
  };
}
