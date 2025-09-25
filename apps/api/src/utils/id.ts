import { createHash } from "crypto";

// if you ever add variant options (e.g., includeTimelines=false), hash them:
function variantHash(opts?: Record<string, unknown>) {
  if (!opts || Object.keys(opts).length === 0) return "";
  const json = JSON.stringify(opts, Object.keys(opts).sort());
  return ":" + createHash("sha1").update(json).digest("hex").slice(0, 8);
}

export function makeJobId(
  scope: string,
  region: string,
  puuid: string,
  opts?: Record<string, unknown>
) {
  return `${scope}:${region}:${puuid}${variantHash(opts)}`;
}
