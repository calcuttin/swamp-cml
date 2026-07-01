/**
 * @calcuttin/cml/lab — Cisco Modeling Labs controller automation via the
 * CML REST API: inventory sync, lab lifecycle, topology import, and
 * per-node/per-link resource fan-out.
 */
import { z } from "npm:zod@4";
import {
  type CmlAuthArgs,
  type CmlLabSnapshot,
  collectLabSnapshot,
  createLab as cmlCreateLab,
  deleteLab as cmlDeleteLab,
  findLabByTitle,
  getLab,
  getSystemInformation,
  importLabYaml,
  linkResourceName,
  listLabIds,
  listNodeDefinitionIds,
  nodeResourceName,
  resolveCmlToken,
  sanitizeResourceName,
  startLab as cmlStartLab,
  stopLab as cmlStopLab,
  wipeLab as cmlWipeLab,
} from "./lib/cml.ts";
import {
  filterTopologies,
  findTopology,
  loadTopologyCatalog,
} from "./lib/cml_catalog.ts";
import { downloadDevNetTopologies } from "./lib/cml_topology_download.ts";

const CmlConnectionArgs = z.object({
  baseUrl: z.string().describe(
    "CML controller base URL (e.g. https://cml.example.com)",
  ),
  token: z.string().optional().describe(
    "Pre-generated JWT from CML UI (Copy JWT) — faster than username/password",
  ),
  username: z.string().optional().describe("CML username"),
  password: z.string().optional().describe("CML password"),
  skipTlsVerify: z.boolean().default(true).describe(
    "Skip TLS certificate verification (common for lab CML installs)",
  ),
});

const LabByTitleArgs = z.object({
  labTitle: z.string().describe("Lab title to operate on"),
});

const CreateLabArgs = z.object({
  title: z.string().describe("Title for the new lab"),
  description: z.string().optional().describe("Optional lab description"),
});

const ImportLabArgs = z.object({
  topologyPath: z.string().describe(
    "Path to topology YAML relative to repo root (e.g. topologies/cisco-devnet/basic-forwarding-behavior.yaml)",
  ),
  title: z.string().optional().describe(
    "Override lab title on import (defaults to title in YAML)",
  ),
  startAfterImport: z.boolean().default(false).describe(
    "Start all nodes after import completes",
  ),
});

const ImportTopologyArgs = z.object({
  topologyId: z.string().describe(
    "Catalog ID from topologies/catalog.json (run listTopologies)",
  ),
  title: z.string().optional().describe("Override lab title on import"),
  startAfterImport: z.boolean().default(false).describe(
    "Start all nodes after import completes",
  ),
});

const ListTopologiesArgs = z.object({
  tag: z.string().optional().describe(
    "Filter by tag (e.g. ccnp-relevant, ccna-prep, ccna)",
  ),
  category: z.string().optional().describe("Filter by exact category string"),
});

const DownloadTopologiesArgs = z.object({
  force: z.boolean().default(false).describe(
    "Re-download YAML files even when local copies already match upstream",
  ),
});

const SyncArgs = z.object({
  includeNodes: z.boolean().default(true).describe(
    "Write one node resource per CML node",
  ),
  includeLinks: z.boolean().default(true).describe(
    "Write one link resource per CML link",
  ),
});

const NodeSchema = z.object({
  id: z.string(),
  label: z.string(),
  nodeDefinition: z.string().optional(),
  state: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  interfaceCount: z.number().optional(),
});

const LinkSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  state: z.string().optional(),
});

const LabDataSchema = z.object({
  labId: z.string(),
  labTitle: z.string(),
  state: z.string().optional(),
  description: z.string().optional(),
  notes: z.string().optional(),
  owner: z.string().optional(),
  created: z.string().optional(),
  modified: z.string().optional(),
  nodeCount: z.number().optional(),
  linkCount: z.number().optional(),
  autostart: z.boolean().optional(),
  nodeStaging: z.boolean().optional(),
  nodes: z.array(NodeSchema).optional(),
  links: z.array(LinkSchema).optional(),
  success: z.boolean().optional(),
  warnings: z.array(z.string()).optional(),
  logs: z.string().optional(),
  timestamp: z.string(),
});

const NodeDataSchema = z.object({
  labId: z.string(),
  labTitle: z.string(),
  nodeId: z.string(),
  label: z.string(),
  nodeDefinition: z.string().optional(),
  state: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  hideLinks: z.boolean().optional(),
  ram: z.number().optional(),
  cpus: z.number().optional(),
  interfaceCount: z.number().optional(),
  logs: z.string().optional(),
  timestamp: z.string(),
});

const LinkDataSchema = z.object({
  labId: z.string(),
  labTitle: z.string(),
  linkId: z.string(),
  label: z.string().optional(),
  state: z.string().optional(),
  node1Label: z.string().optional(),
  node2Label: z.string().optional(),
  logs: z.string().optional(),
  timestamp: z.string(),
});

const SystemDataSchema = z.object({
  version: z.string().optional(),
  ready: z.boolean().optional(),
  features: z.array(z.string()).optional(),
  baseUrl: z.string(),
  logs: z.string().optional(),
  timestamp: z.string(),
});

const TopologyDataSchema = z.object({
  topologyId: z.string(),
  title: z.string(),
  description: z.string().optional(),
  path: z.string(),
  source: z.string().optional(),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  nodeDefinitions: z.array(z.string()).optional(),
  logs: z.string().optional(),
  timestamp: z.string(),
});

const CatalogDownloadDataSchema = z.object({
  catalogPath: z.string(),
  topologyCount: z.number(),
  downloaded: z.number(),
  skippedExisting: z.number(),
  excludedIncompatible: z.number(),
  excludedSkipped: z.number(),
  ccnpRelevantCount: z.number().optional(),
  logs: z.string().optional(),
  timestamp: z.string(),
});

type GlobalArgs = z.infer<typeof CmlConnectionArgs>;
type WriteResource = (
  specName: string,
  name: string,
  data: Record<string, unknown>,
) => Promise<{ name: string }>;
type MethodContext = { globalArgs: GlobalArgs; writeResource: WriteResource };

function authArgs(globalArgs: GlobalArgs): CmlAuthArgs {
  return {
    baseUrl: globalArgs.baseUrl,
    skipTlsVerify: globalArgs.skipTlsVerify,
    token: globalArgs.token,
    username: globalArgs.username,
    password: globalArgs.password,
  };
}

function makeLogger() {
  const logs: string[] = [];
  return {
    log: (msg: string) => logs.push(msg),
    text: () => logs.join("\n"),
  };
}

async function resolveLab(
  globalArgs: GlobalArgs,
  token: string,
  labTitle: string,
) {
  const lab = await findLabByTitle(authArgs(globalArgs), token, labTitle);
  if (!lab) {
    const ids = await listLabIds(authArgs(globalArgs), token);
    const titles: string[] = [];
    for (const id of ids.slice(0, 10)) {
      const detail = await getLab(authArgs(globalArgs), token, id);
      titles.push(detail.lab_title);
    }
    throw new Error(
      `Lab "${labTitle}" not found. Known titles: ${
        titles.join(", ") || "(none)"
      }`,
    );
  }
  return lab;
}

function labPayload(
  snapshot: CmlLabSnapshot,
  logs: string,
  extra: Record<string, unknown> = {},
) {
  const { lab, nodes, links } = snapshot;
  return {
    labId: lab.id,
    labTitle: lab.lab_title,
    state: lab.state,
    description: lab.lab_description,
    notes: lab.lab_notes,
    owner: lab.owner_username,
    created: lab.created,
    modified: lab.modified,
    nodeCount: lab.node_count ?? nodes.length,
    linkCount: lab.link_count ?? links.length,
    autostart: lab.autostart?.enabled,
    nodeStaging: lab.node_staging?.enabled,
    nodes: nodes.map((n) => ({
      id: n.id,
      label: n.label,
      nodeDefinition: n.node_definition,
      state: n.state,
      x: n.x,
      y: n.y,
      interfaceCount: n.interfaces?.length,
    })),
    links: links.map((l) => ({
      id: l.id,
      label: l.label,
      state: l.state,
    })),
    logs,
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

async function writeLabSnapshot(
  context: MethodContext,
  snapshot: CmlLabSnapshot,
  logs: string,
  options: {
    includeNodes?: boolean;
    includeLinks?: boolean;
    labExtra?: Record<string, unknown>;
  } = {},
) {
  const includeNodes = options.includeNodes ?? true;
  const includeLinks = options.includeLinks ?? true;
  const handles = [];
  const { lab, nodes, links } = snapshot;
  const labName = sanitizeResourceName(lab.lab_title);

  handles.push(
    await context.writeResource(
      "lab",
      labName,
      labPayload(snapshot, logs, options.labExtra ?? {}),
    ),
  );

  if (includeNodes) {
    for (const node of nodes) {
      handles.push(
        await context.writeResource(
          "node",
          nodeResourceName(lab.lab_title, node.label),
          {
            labId: lab.id,
            labTitle: lab.lab_title,
            nodeId: node.id,
            label: node.label,
            nodeDefinition: node.node_definition,
            state: node.state,
            x: node.x,
            y: node.y,
            hideLinks: node.hide_links,
            ram: node.ram,
            cpus: node.cpus,
            interfaceCount: node.interfaces?.length ?? 0,
            logs,
            timestamp: new Date().toISOString(),
          },
        ),
      );
    }
  }

  if (includeLinks) {
    const nodeById = new Map(nodes.map((n) => [n.id, n.label]));
    for (const link of links) {
      handles.push(
        await context.writeResource(
          "link",
          linkResourceName(lab.lab_title, link.id),
          {
            labId: lab.id,
            labTitle: lab.lab_title,
            linkId: link.id,
            label: link.label,
            state: link.state,
            node1Label: link.n1 ? nodeById.get(link.n1) : undefined,
            node2Label: link.n2 ? nodeById.get(link.n2) : undefined,
            logs,
            timestamp: new Date().toISOString(),
          },
        ),
      );
    }
  }

  return handles;
}

async function importYamlContent(
  context: MethodContext,
  yaml: string,
  options: {
    title?: string;
    startAfterImport?: boolean;
    sourceLabel: string;
  },
) {
  const { log, text } = makeLogger();
  const globalArgs = context.globalArgs;
  log(`Importing topology from ${options.sourceLabel}`);
  const token = await resolveCmlToken(authArgs(globalArgs));
  const result = await importLabYaml(
    authArgs(globalArgs),
    token,
    yaml,
    options.title,
  );
  log(`Imported lab ${result.id}`);
  if (result.warnings?.length) {
    for (const w of result.warnings) log(`  warning: ${w}`);
  }
  if (options.startAfterImport) {
    log(`Starting lab ${result.id}`);
    await cmlStartLab(authArgs(globalArgs), token, result.id);
  }
  const snapshot = await collectLabSnapshot(
    authArgs(globalArgs),
    token,
    result.id,
  );
  log(
    `Lab "${snapshot.lab.lab_title}" — ${snapshot.nodes.length} nodes, ${snapshot.links.length} links`,
  );
  return writeLabSnapshot(context, snapshot, text(), {
    includeNodes: true,
    includeLinks: true,
    labExtra: { success: true, warnings: result.warnings ?? [] },
  });
}

/** Swamp model definition for `@calcuttin/cml/lab`. */
export const model = {
  type: "@calcuttin/cml/lab",
  version: "2026.07.01.6",
  resources: {
    "lab": {
      description: "CML lab summary with embedded node/link inventory",
      schema: LabDataSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "node": {
      description: "Individual CML lab node (router, switch, host, etc.)",
      schema: NodeDataSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "link": {
      description: "Individual CML lab link between two node interfaces",
      schema: LinkDataSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "system": {
      description: "CML controller system information",
      schema: SystemDataSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    "topology": {
      description: "Entry from topologies/catalog.json (Cisco DevNet labs)",
      schema: TopologyDataSchema,
      lifetime: "infinite",
      garbageCollection: 30,
    },
    "catalog": {
      description: "Result of downloading DevNet topologies into the repo",
      schema: CatalogDownloadDataSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  globalArguments: CmlConnectionArgs,
  methods: {
    getSystemInfo: {
      description: "Fetch CML controller version, readiness, and feature flags",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext & { repoDir?: string },
      ) => {
        const { log, text } = makeLogger();
        const globalArgs = context.globalArgs;
        log(`Querying CML system info at ${globalArgs.baseUrl}`);
        const token = await resolveCmlToken(authArgs(globalArgs));
        const info = await getSystemInformation(authArgs(globalArgs), token);
        log(`CML version ${info.version ?? "unknown"}, ready=${info.ready}`);
        const handle = await context.writeResource("system", "controller", {
          version: info.version,
          ready: info.ready,
          features: info.features ?? [],
          baseUrl: globalArgs.baseUrl,
          logs: text(),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    sync: {
      description:
        "Sync all labs — one lab resource per title plus node/link resources",
      arguments: SyncArgs,
      execute: async (
        args: z.infer<typeof SyncArgs>,
        context: MethodContext,
      ) => {
        const { log, text } = makeLogger();
        const globalArgs = context.globalArgs;
        log(`Connecting to CML at ${globalArgs.baseUrl}`);
        const token = await resolveCmlToken(authArgs(globalArgs));
        log("Authenticated");

        const labIds = await listLabIds(authArgs(globalArgs), token);
        log(`Found ${labIds.length} lab(s)`);

        const handles = [];
        for (const labId of labIds) {
          const snapshot = await collectLabSnapshot(
            authArgs(globalArgs),
            token,
            labId,
          );
          log(
            `  ${snapshot.lab.lab_title} [${
              snapshot.lab.state ?? "?"
            }] — ${snapshot.nodes.length} node(s), ${snapshot.links.length} link(s)`,
          );
          for (const node of snapshot.nodes) {
            log(
              `    node ${node.label} (${node.node_definition}) [${
                node.state ?? "?"
              }]`,
            );
          }
          const labHandles = await writeLabSnapshot(
            context,
            snapshot,
            text(),
            {
              includeNodes: args.includeNodes,
              includeLinks: args.includeLinks,
            },
          );
          handles.push(...labHandles);
        }

        log(`Complete: ${handles.length} resource(s) written`);
        return { dataHandles: handles };
      },
    },

    lookup: {
      description:
        "Look up a lab by title and write lab + node + link resources",
      arguments: LabByTitleArgs,
      execute: async (
        args: z.infer<typeof LabByTitleArgs>,
        context: MethodContext,
      ) => {
        const { log, text } = makeLogger();
        const globalArgs = context.globalArgs;
        log(`Looking up lab "${args.labTitle}"`);
        const token = await resolveCmlToken(authArgs(globalArgs));
        const lab = await resolveLab(globalArgs, token, args.labTitle);
        const snapshot = await collectLabSnapshot(
          authArgs(globalArgs),
          token,
          lab.id!,
        );
        log(
          `Found ${snapshot.lab.id} — ${snapshot.nodes.length} nodes, ${snapshot.links.length} links`,
        );
        const handles = await writeLabSnapshot(context, snapshot, text());
        return { dataHandles: handles };
      },
    },

    createLab: {
      description: "Create a new empty CML lab",
      arguments: CreateLabArgs,
      execute: async (
        args: z.infer<typeof CreateLabArgs>,
        context: MethodContext,
      ) => {
        const { log, text } = makeLogger();
        const globalArgs = context.globalArgs;
        log(`Creating lab "${args.title}"`);
        const token = await resolveCmlToken(authArgs(globalArgs));
        const created = await cmlCreateLab(
          authArgs(globalArgs),
          token,
          args.title,
          args.description ?? "",
        );
        log(`Created lab ${created.id}`);
        const snapshot = await collectLabSnapshot(
          authArgs(globalArgs),
          token,
          created.id,
        );
        const handle = await context.writeResource(
          "lab",
          sanitizeResourceName(args.title),
          labPayload(snapshot, text(), { success: true }),
        );
        return { dataHandles: [handle] };
      },
    },

    listTopologies: {
      description:
        "List Cisco DevNet topologies from topologies/catalog.json (one resource per entry)",
      arguments: ListTopologiesArgs,
      execute: async (
        args: z.infer<typeof ListTopologiesArgs>,
        context: MethodContext & { repoDir?: string },
      ) => {
        const { log, text } = makeLogger();
        const repoDir = context.repoDir ?? ".";
        log(`Loading topology catalog from ${repoDir}/topologies/catalog.json`);
        const catalog = await loadTopologyCatalog(repoDir);
        const entries = filterTopologies(
          catalog,
          args.tag,
          args.category,
        );
        log(
          `Catalog: ${catalog.topologies.length} total, ${entries.length} after filter`,
        );
        const handles = [];
        for (const entry of entries) {
          log(
            `  ${entry.id}: ${entry.title} [${(entry.tags ?? []).join(", ")}]`,
          );
          handles.push(
            await context.writeResource("topology", entry.id, {
              topologyId: entry.id,
              title: entry.title,
              description: entry.description,
              path: `topologies/${entry.path}`,
              source: entry.source,
              category: entry.category,
              tags: entry.tags ?? [],
              nodeDefinitions: entry.nodeDefinitions ?? [],
              logs: text(),
              timestamp: new Date().toISOString(),
            }),
          );
        }
        return { dataHandles: handles };
      },
    },

    downloadTopologies: {
      description:
        "Download compatible Cisco DevNet cml-community topologies into topologies/cisco-devnet/ and rebuild catalog.json (filtered to node types on your CML controller)",
      arguments: DownloadTopologiesArgs,
      execute: async (
        args: z.infer<typeof DownloadTopologiesArgs>,
        context: MethodContext & { repoDir?: string },
      ) => {
        const { log, text } = makeLogger();
        const repoDir = context.repoDir ?? ".";
        const globalArgs = context.globalArgs;

        log(`Resolving node definitions from ${globalArgs.baseUrl}`);
        const token = await resolveCmlToken(authArgs(globalArgs));
        const nodeTypeIds = await listNodeDefinitionIds(
          authArgs(globalArgs),
          token,
        );
        log(`CML supports ${nodeTypeIds.length} node type(s)`);

        const result = await downloadDevNetTopologies({
          repoDir,
          availableNodeTypes: new Set(nodeTypeIds),
          force: args.force,
          log,
        });

        const ccnpRelevantCount =
          result.catalog.topologies.filter((entry) =>
            (entry.tags ?? []).includes("ccnp-relevant")
          ).length;

        const handle = await context.writeResource("catalog", "devnet", {
          catalogPath: result.catalogPath,
          topologyCount: result.catalog.topologies.length,
          downloaded: result.downloaded,
          skippedExisting: result.skippedExisting,
          excludedIncompatible: result.excludedIncompatible,
          excludedSkipped: result.excludedSkipped,
          ccnpRelevantCount,
          logs: text(),
          timestamp: new Date().toISOString(),
        });

        return { dataHandles: [handle] };
      },
    },

    importTopology: {
      description: "Import a topology by catalog ID (see listTopologies)",
      arguments: ImportTopologyArgs,
      execute: async (
        args: z.infer<typeof ImportTopologyArgs>,
        context: MethodContext & { repoDir?: string },
      ) => {
        const repoDir = context.repoDir ?? ".";
        const catalog = await loadTopologyCatalog(repoDir);
        const entry = findTopology(catalog, args.topologyId);
        const topologyPath = `${repoDir}/topologies/${entry.path}`.replace(
          /\/+/g,
          "/",
        );
        const yaml = await Deno.readTextFile(topologyPath);
        const handles = await importYamlContent(context, yaml, {
          title: args.title,
          startAfterImport: args.startAfterImport,
          sourceLabel: `catalog:${entry.id} (${entry.title})`,
        });
        return { dataHandles: handles };
      },
    },

    importLab: {
      description:
        "Import a topology YAML file from the repo into CML (POST /api/v0/import)",
      arguments: ImportLabArgs,
      execute: async (
        args: z.infer<typeof ImportLabArgs>,
        context: MethodContext & { repoDir?: string },
      ) => {
        const repoDir = context.repoDir ?? ".";
        const topologyPath = `${repoDir}/${args.topologyPath}`.replace(
          /\/+/g,
          "/",
        );
        const yaml = await Deno.readTextFile(topologyPath);
        const handles = await importYamlContent(context, yaml, {
          title: args.title,
          startAfterImport: args.startAfterImport,
          sourceLabel: args.topologyPath,
        });
        return { dataHandles: handles };
      },
    },

    startLab: {
      description: "Start all nodes in a CML lab by title",
      arguments: LabByTitleArgs,
      execute: async (
        args: z.infer<typeof LabByTitleArgs>,
        context: MethodContext,
      ) => {
        const { log, text } = makeLogger();
        const globalArgs = context.globalArgs;
        log(`Starting lab "${args.labTitle}"`);
        const token = await resolveCmlToken(authArgs(globalArgs));
        const lab = await resolveLab(globalArgs, token, args.labTitle);
        await cmlStartLab(authArgs(globalArgs), token, lab.id!);
        log(`Start requested for ${lab.id}`);
        const snapshot = await collectLabSnapshot(
          authArgs(globalArgs),
          token,
          lab.id!,
        );
        const handles = await writeLabSnapshot(context, snapshot, text(), {
          includeNodes: false,
          includeLinks: false,
        });
        return { dataHandles: handles };
      },
    },

    stopLab: {
      description: "Stop all nodes in a CML lab by title",
      arguments: LabByTitleArgs,
      execute: async (
        args: z.infer<typeof LabByTitleArgs>,
        context: MethodContext,
      ) => {
        const { log, text } = makeLogger();
        const globalArgs = context.globalArgs;
        log(`Stopping lab "${args.labTitle}"`);
        const token = await resolveCmlToken(authArgs(globalArgs));
        const lab = await resolveLab(globalArgs, token, args.labTitle);
        await cmlStopLab(authArgs(globalArgs), token, lab.id!);
        log(`Stop requested for ${lab.id}`);
        const snapshot = await collectLabSnapshot(
          authArgs(globalArgs),
          token,
          lab.id!,
        );
        const handles = await writeLabSnapshot(context, snapshot, text(), {
          includeNodes: false,
          includeLinks: false,
        });
        return { dataHandles: handles };
      },
    },

    wipeLab: {
      description: "Wipe all node runtime state in a lab (configs preserved)",
      arguments: LabByTitleArgs,
      execute: async (
        args: z.infer<typeof LabByTitleArgs>,
        context: MethodContext,
      ) => {
        const { log, text } = makeLogger();
        const globalArgs = context.globalArgs;
        log(`Wiping lab "${args.labTitle}"`);
        const token = await resolveCmlToken(authArgs(globalArgs));
        const lab = await resolveLab(globalArgs, token, args.labTitle);
        await cmlWipeLab(authArgs(globalArgs), token, lab.id!);
        log(`Wipe requested for ${lab.id}`);
        const snapshot = await collectLabSnapshot(
          authArgs(globalArgs),
          token,
          lab.id!,
        );
        const handles = await writeLabSnapshot(context, snapshot, text());
        return { dataHandles: handles };
      },
    },

    deleteLab: {
      description: "Delete a CML lab by title",
      arguments: LabByTitleArgs,
      execute: async (
        args: z.infer<typeof LabByTitleArgs>,
        context: MethodContext,
      ) => {
        const { log, text } = makeLogger();
        const globalArgs = context.globalArgs;
        log(`Deleting lab "${args.labTitle}"`);
        const token = await resolveCmlToken(authArgs(globalArgs));
        const lab = await resolveLab(globalArgs, token, args.labTitle);
        const labId = lab.id!;
        const labTitle = lab.lab_title;
        await cmlDeleteLab(authArgs(globalArgs), token, labId);
        log(`Deleted lab ${labId}`);
        const handle = await context.writeResource(
          "lab",
          sanitizeResourceName(labTitle),
          {
            labId,
            labTitle,
            state: "DELETED",
            success: true,
            logs: text(),
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
