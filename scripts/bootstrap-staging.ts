#!/usr/bin/env bun
/**
 * scripts/bootstrap-staging.ts
 *
 * Generate secrets for the EdgeProbe staging backend and print the exact
 * commands to install them:
 *   1. `fly secrets set ...`  →  feeds the server (SHARE_TOKEN_SECRET, BOOTSTRAP_API_KEYS)
 *   2. `gh secret set ...`    →  feeds the demo PR Action (ingest + dashboard keys)
 *
 * This is a pure-local script — it does NOT hit any network, does NOT call
 * the backend. Run it once per staging reset. Keep the output somewhere
 * safe (1Password / `fly secrets list` is NOT a recovery mechanism, the
 * raw tokens are only printed to your terminal here).
 *
 * Usage:
 *   bun run scripts/bootstrap-staging.ts [--org org_demo]
 *
 * Why pre-compute tokens instead of minting via `/app/keys`?
 *   The server's `/app/keys` endpoint requires an existing priv key to
 *   authenticate — classic bootstrap chicken-and-egg. `BOOTSTRAP_API_KEYS`
 *   seeds the store on boot from a known raw token, which is exactly the
 *   hand-off we need here.
 */

import { randomBytes } from "node:crypto"

interface BootstrapConfig {
  orgId: string
}

function parseArgs(argv: string[]): BootstrapConfig {
  const out: BootstrapConfig = { orgId: "org_demo" }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = argv[i + 1]
    if (arg === "--org" && next) {
      out.orgId = next
      i++
    }
  }
  return out
}

/**
 * Token layout matches `generateRawToken` in backend/src/apiKeys.ts:
 *   epk_<type>_<10 hex id>_<32 hex secret>
 *
 * We duplicate the format here (instead of importing) so this script
 * stays a single file runnable before backend deps are installed.
 */
function mintToken(keyType: "pub" | "priv"): string {
  const id = randomBytes(5).toString("hex")
  const secret = randomBytes(16).toString("hex")
  return `epk_${keyType}_${id}_${secret}`
}

function main(): void {
  const cfg = parseArgs(process.argv.slice(2))

  const ingestKey = mintToken("pub")    // Action -> POST /ingest
  const privKey   = mintToken("priv")   // Action -> POST /app/trace/:id/share
  const shareSecret = randomBytes(32).toString("hex")  // 64 chars, exceeds 32 min

  const bootstrap = {
    [ingestKey]: { orgId: cfg.orgId, keyType: "pub",  name: "demo-ingest" },
    [privKey]:   { orgId: cfg.orgId, keyType: "priv", name: "demo-dashboard" },
  }

  // Single-line JSON so it's safe to paste into a shell with single quotes.
  const bootstrapBlob = JSON.stringify(bootstrap)

  console.log("# ───────────────────────────────────────────────────────────")
  console.log("# 1. Fly server secrets — run once after `fly launch`:")
  console.log("# ───────────────────────────────────────────────────────────")
  console.log("cd backend && fly secrets set \\")
  console.log(`  SHARE_TOKEN_SECRET='${shareSecret}' \\`)
  console.log(`  BOOTSTRAP_API_KEYS='${bootstrapBlob}'`)
  console.log()
  console.log("# ───────────────────────────────────────────────────────────")
  console.log("# 2. GitHub Actions repo secrets — so demo PR workflows auth:")
  console.log("# ───────────────────────────────────────────────────────────")
  console.log(`gh secret set EDGEPROBE_INGEST_KEY    --body '${ingestKey}'`)
  console.log(`gh secret set EDGEPROBE_DASHBOARD_KEY --body '${privKey}'`)
  console.log()
  console.log("# ───────────────────────────────────────────────────────────")
  console.log("# 3. Keep a copy somewhere safe (1Password / offline):")
  console.log("# ───────────────────────────────────────────────────────────")
  console.log(`org_id              = ${cfg.orgId}`)
  console.log(`ingest key (pub)    = ${ingestKey}`)
  console.log(`dashboard key (priv)= ${privKey}`)
  console.log(`share-token secret  = ${shareSecret}`)
  console.log()
  console.log("# Rotating?  Run this script again, re-apply (1) + (2).")
  console.log("# Old keys keep working until you revoke via DELETE /app/keys/:id.")
}

main()
