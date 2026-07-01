---
name: cml
description: >-
  Automate Cisco Modeling Labs (CML) via @calcuttin/cml/lab — sync lab/node/link
  inventory, import DevNet topologies from catalog, lifecycle methods, vault
  credentials. Use when the user mentions CML, Cisco Modeling Labs, network lab
  automation, or CCNP/CCNA labs. For interactive topology design in Cursor, use
  the built-in CML 2.10 MCP at the user's controller URL + /mcp.
---

# Cisco Modeling Labs (CML)

## Controller URL

The CML controller address is **not fixed** — each user sets it on their model
instance via the `baseUrl` global argument (e.g. `https://cml.lab.local` or
`https://10.0.0.50`).

```bash
# Read the configured URL from the user's model instance
swamp model get cml-controller --json
# → globalArguments.baseUrl
```

When documenting MCP or curl examples, substitute the user's `baseUrl`. MCP
endpoint: **`{baseUrl}/mcp`** (port 443 on standard installs).

## Swamp model

| Model | Type | Purpose |
|---|---|---|
| `cml-controller` | `@calcuttin/cml/lab` | CML REST API (URL from `baseUrl`) |

### Global arguments

| Field | Notes |
|---|---|
| `baseUrl` | CML controller base URL — **required, user-specific** |
| `skipTlsVerify` | Default `true` for self-signed lab certs |
| `username` / `password` | From vault `cml`, or use `token` (JWT) |

### Methods

| Method | Use |
|---|---|
| `getSystemInfo` | CML version, readiness, features |
| `sync` | Fan-out: `lab` + `node` + `link` resources for every lab |
| `lookup` | Full snapshot for one lab by title |
| `createLab` | Create empty lab |
| `listTopologies` | List DevNet catalog entries (filter by `tag` or `category`) |
| `downloadTopologies` | Download DevNet YAML labs from GitHub into `topologies/` |
| `importTopology` | Import by catalog ID from `topologies/catalog.json` |
| `importLab` | Import topology YAML from repo path |
| `startLab` / `stopLab` | Lab lifecycle |
| `wipeLab` | Wipe node runtime state |
| `deleteLab` | Remove lab |

### Resources

| Spec | Contents |
|---|---|
| `lab` | Summary + embedded node/link index |
| `node` | Per-device: label, type, state, RAM/CPU |
| `link` | Per-link: endpoints, state |
| `topology` | DevNet catalog entry (id, path, tags, node types) |
| `catalog` | DevNet download summary |
| `system` | Controller metadata |

### First-time setup

```bash
swamp vault create local_encryption cml
swamp vault put cml USERNAME 'your-cml-user'
swamp vault put cml PASSWORD 'your-cml-password'

swamp model create @calcuttin/cml/lab cml-controller \
  --global-arg baseUrl=https://<cml-host> \
  --global-arg skipTlsVerify=true \
  --global-arg 'username=${{ vault.get("cml", "USERNAME") }}' \
  --global-arg 'password=${{ vault.get("cml", "PASSWORD") }}'
```

Replace `<cml-host>` with the hostname or IP the user provides.

### Cisco DevNet topology catalog

Topologies are **not bundled** in the extension. Download once, then import by catalog ID.

```bash
# Download compatible DevNet labs (filtered to your CML node types)
swamp workflow run @calcuttin/download-devnet-topologies

# Sync inventory
swamp workflow run @calcuttin/sync-cml-labs

# Browse catalog
swamp model @calcuttin/cml/lab method run listTopologies cml-controller
swamp model @calcuttin/cml/lab method run listTopologies cml-controller --input tag=ccnp-relevant

# Import by catalog ID
swamp workflow run @calcuttin/import-topology --input topologyId=basic-forwarding-behavior
swamp workflow run @calcuttin/import-topology-and-sync --input topologyId=basic-forwarding-behavior

# CCNP preset
swamp workflow run @calcuttin/import-ccnp-topology

# Query synced data
swamp model @calcuttin/cml/lab method run lookup cml-controller --input labTitle='My Lab'
swamp data query cml-controller 'attributes.label == "R1"'
```

Source: [CiscoDevNet/cml-community](https://github.com/CiscoDevNet/cml-community)

## MCP (Cursor interactive)

CML **2.10+** includes a built-in MCP server at **`{baseUrl}/mcp`**.

```json
{
  "mcpServers": {
    "CML (built-in)": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<cml-host>/mcp", "--header", "X-Authorization: Basic BASE64_USER_PASS"],
      "env": { "NODE_TLS_REJECT_UNAUTHORIZED": "0" }
    }
  }
}
```

Replace `<cml-host>` with the user's controller hostname/IP (same value as
`baseUrl` without the scheme, or use the full URL in `mcp-remote`).

Swamp = repeatable pipelines. MCP = interactive lab design.
