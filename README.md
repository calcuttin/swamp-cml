# @calcuttin/cml

[Swamp](https://github.com/swamp-club/swamp) extension for **Cisco Modeling Labs (CML) 2.x**
controller automation via the REST API.

## Models

### `@calcuttin/cml/lab`

| Method | Description |
|--------|-------------|
| `getSystemInfo` | CML version, readiness, feature flags |
| `sync` | Fan-out: one `lab`, `node`, and `link` resource per CML object |
| `lookup` | Full snapshot for a single lab by title |
| `createLab` | Create an empty lab |
| `listTopologies` | List DevNet catalog entries from `topologies/catalog.json` |
| `downloadTopologies` | Download DevNet YAML labs from GitHub into `topologies/` |
| `importTopology` | Import by catalog ID |
| `importLab` | Import topology YAML from repo path |
| `startLab` | Start all nodes in a lab |
| `stopLab` | Stop all nodes in a lab |
| `wipeLab` | Wipe node runtime state |
| `deleteLab` | Delete a lab |

## Resources

| Spec | Description |
|------|-------------|
| `lab` | Lab summary with embedded node/link index |
| `node` | Individual node (label, type, state, RAM/CPU) |
| `link` | Individual link with endpoint node labels |
| `topology` | DevNet catalog entry (id, path, tags, node types) |
| `catalog` | DevNet download summary (counts, catalog path) |
| `system` | Controller metadata |

## Quick start

```bash
swamp vault create local_encryption cml
swamp vault put cml USERNAME 'admin'
swamp vault put cml PASSWORD 'your-password'

swamp model create @calcuttin/cml/lab cml-controller \
  --global-arg baseUrl=https://<cml-host> \
  --global-arg skipTlsVerify=true \
  --global-arg 'username=${{ vault.get("cml", "USERNAME") }}' \
  --global-arg 'password=${{ vault.get("cml", "PASSWORD") }}'

swamp workflow run @calcuttin/sync-cml-labs
swamp data list cml-controller
swamp data query cml-controller 'attributes.label == "R1"'
```

## Cisco DevNet topology catalog

Topologies are **not stored in git** (see repo `topologies/README.md`). Download them on demand:

```bash
# Download compatible DevNet labs (~60) filtered to your CML node types
swamp workflow run @calcuttin/download-devnet-topologies
# Or directly:
swamp model @calcuttin/cml/lab method run downloadTopologies cml-controller

# Browse catalog (after download)
swamp model @calcuttin/cml/lab method run listTopologies cml-controller
swamp model @calcuttin/cml/lab method run listTopologies cml-controller --input tag=ccnp-relevant

# Import any catalog lab by ID
swamp workflow run @calcuttin/import-topology --input topologyId=basic-forwarding-behavior
swamp workflow run @calcuttin/import-topology-and-sync --input topologyId=basic-forwarding-behavior

# CCNP preset (basic-forwarding-behavior + start)
swamp workflow run @calcuttin/import-ccnp-topology
```

Source: [CiscoDevNet/cml-community](https://github.com/CiscoDevNet/cml-community)

## Import a custom topology

Place a CML 2.x YAML file in your repo (e.g. `topologies/ccnp.yaml`), then:

```bash
swamp model @calcuttin/cml/lab method run importLab cml-controller \
  --input topologyPath=topologies/ccnp.yaml \
  --input title='My Lab'
```

## MCP

CML 2.10+ includes a built-in MCP server at `https://<cml-host>/mcp` for interactive
lab design in Cursor. Use Swamp for repeatable workflows; use MCP for ad-hoc topology
building.

## Requirements

- CML 2.9+ (tested on 2.10)
- `curl` on the Swamp runner (for TLS skip on self-signed lab certs)
