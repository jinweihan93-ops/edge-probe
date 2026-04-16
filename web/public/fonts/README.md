# Fonts

The canonical design (`docs/DESIGN.md`) requires **Inter** and **IBM Plex Mono**, self-hosted as WOFF2. System fallbacks carry the page until these files exist, so the site still reads correctly — but for a ship-quality viral surface, populate this directory with the five files listed below.

## What to fetch

Filename in this dir must match what `public/styles/tokens.css` references:

- `inter-400.woff2` — Inter Regular (400)
- `inter-500.woff2` — Inter Medium (500)
- `inter-600.woff2` — Inter SemiBold (600)
- `plex-mono-400.woff2` — IBM Plex Mono Regular (400)
- `plex-mono-500.woff2` — IBM Plex Mono Medium (500)

Latin subset only. The full file is ~4× larger and we never render non-Latin on the public share.

## How to fetch

The canonical source is Google Fonts' static CSS API. The WOFF2 URLs are stable. Example (one-off, commit the resulting files):

```bash
# from repo root
cd web/public/fonts

# Inter — pull the latin subset at each weight
curl -L -o inter-400.woff2 "https://fonts.gstatic.com/s/inter/v18/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7.woff2"
curl -L -o inter-500.woff2 "https://fonts.gstatic.com/s/inter/v18/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa2pL7.woff2"
curl -L -o inter-600.woff2 "https://fonts.gstatic.com/s/inter/v18/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa25L7.woff2"

# IBM Plex Mono
curl -L -o plex-mono-400.woff2 "https://fonts.gstatic.com/s/ibmplexmono/v19/-F63fjptAgt5VM-kVkqdyU8n3kwq0n1hj-sNFQ.woff2"
curl -L -o plex-mono-500.woff2 "https://fonts.gstatic.com/s/ibmplexmono/v19/-F6sfjptAgt5VM-kVkqdyU8n3owSp3YP9Sgh.woff2"
```

The exact URL for each weight can change as Google Fonts versions the files; the resilient way to get them is:

```bash
curl -L -H "User-Agent: Mozilla/5.0" \
  "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap"
```

Parse the `url(...)` entries out of that CSS and fetch each one.

## Licensing

Both families are OFL 1.1. Rehosting the WOFF2 files is fine. See `inter-LICENSE.txt` and `plex-mono-LICENSE.txt` next to the files when you commit them.
