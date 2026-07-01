/** Download Cisco DevNet cml-community topologies into topologies/cisco-devnet/. */

import { fetchWithCurl } from "./cml.ts";
import type { TopologyCatalog, TopologyCatalogEntry } from "./cml_catalog.ts";

const GITHUB_TREE_URL =
  "https://api.github.com/repos/CiscoDevNet/cml-community/git/trees/master?recursive=1";
const RAW_BASE =
  "https://raw.githubusercontent.com/CiscoDevNet/cml-community/master";
const UPSTREAM_PREFIX = "lab-topologies/";

const SKIP_UPSTREAM_PATHS = new Set([
  "lab-topologies/ccna/Domain_1/1.1-explore_fundamentals/Task_-_1.1__Netwotk_Fundamentals(Solution).yaml",
  "lab-topologies/sandbox-multiplatform-network/multi-platform-network.yaml",
]);

export type DownloadTopologiesOptions = {
  repoDir: string;
  availableNodeTypes: Set<string>;
  force?: boolean;
  log?: (msg: string) => void;
};

export type DownloadTopologiesResult = {
  catalog: TopologyCatalog;
  downloaded: number;
  skippedExisting: number;
  excludedIncompatible: number;
  excludedSkipped: number;
  catalogPath: string;
};

type GitHubTreeItem = { path: string; type: string };

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function localRelativePath(upstreamPath: string): string {
  return upstreamPath.replace(UPSTREAM_PREFIX, "cisco-devnet/");
}

function categoryFromPath(upstreamPath: string): string {
  const relative = upstreamPath.slice(UPSTREAM_PREFIX.length);
  const parts = relative.split("/");
  if (parts.length === 1) {
    return parts[0].replace(/\.yaml$/i, "");
  }
  return parts.slice(0, -1).join("/");
}

function parseLabMetadata(yaml: string): {
  title?: string;
  description?: string;
  nodeDefinitions: string[];
} {
  const titleMatch = yaml.match(
    /^[\s-]*title:\s*(?:['"]([^'"]+)['"]|(.+?))\s*$/m,
  );
  const descriptionMatch = yaml.match(
    /^[\s-]*description:\s*(?:['"]([^'"]+)['"]|(.+?))\s*$/m,
  );
  const nodeDefinitions = [
    ...yaml.matchAll(/^\s*node_definition:\s*(\S+)\s*$/gm),
  ].map((match) => match[1]);

  const title = titleMatch?.[1] ?? titleMatch?.[2]?.trim();
  const description = descriptionMatch?.[1] ??
    descriptionMatch?.[2]?.trim();

  return {
    title: title?.replace(/^['"]|['"]$/g, ""),
    description: description?.replace(/^['"]|['"]$/g, ""),
    nodeDefinitions: [...new Set(nodeDefinitions)],
  };
}

function isCcnpRelevant(
  upstreamPath: string,
  category: string,
  title: string,
): boolean {
  const pathLower = upstreamPath.toLowerCase();
  const titleLower = title.toLowerCase();

  if (
    category === "basic-forwarding-behavior" ||
    category === "ipsec-exploration" ||
    category.startsWith("aaa-tacacs") ||
    category === "300-node-lab"
  ) {
    return true;
  }

  const ccnaPrepExclude = [
    "/ccna-prep/s1e7/",
    "/ccna-prep/s2e2/",
    "/ccna-prep/s2e4/",
    "/ccna-prep/s2e5/",
    "/ccna-prep/s2e6/",
    "/ccna-prep/s2e7/",
    "/ccna-prep/s3e1/",
  ];
  if (ccnaPrepExclude.some((part) => pathLower.includes(part))) {
    return false;
  }

  if (pathLower.includes("/ccna/domain_1/")) {
    return false;
  }

  if (
    pathLower.includes("/ccna/domain_2/2.2-configure_interswitch") ||
    pathLower.includes("/ccna/domain_2/2.3-configure_l2_discovery")
  ) {
    return false;
  }

  if (pathLower.includes("/ccna/domain_4/4.8-configure_remote_access")) {
    return false;
  }

  if (
    /ospf|vlan|stp|etherchannel|static.routing|nat\b|acl|ipsec|aaa|tacacs|forwarding|dhcp|routing|broadcast|dr-bdr/
      .test(
        `${titleLower} ${category.toLowerCase()}`,
      )
  ) {
    return true;
  }

  return pathLower.includes("/ccna/domain_3/") ||
    pathLower.includes("/ccna/domain_2/2.1-configure_vlans") ||
    pathLower.includes("/ccna/domain_2/2.5-interpret_stp") ||
    pathLower.includes("/ccna-prep/");
}

function buildTags(category: string, ccnpRelevant: boolean): string[] {
  const tags = new Set<string>();
  const topLevel = category.split("/")[0];
  if (topLevel) tags.add(topLevel);
  if (category.startsWith("ccna/Domain_")) tags.add("ccna");
  if (ccnpRelevant) tags.add("ccnp-relevant");
  return [...tags];
}

function assignCatalogId(
  upstreamPath: string,
  title: string,
  usedIds: Set<string>,
): string {
  const fileStem = upstreamPath.split("/").pop()?.replace(/\.yaml$/i, "") ?? "";
  const candidates = [
    slugify(title),
    slugify(fileStem),
    slugify(`${categoryFromPath(upstreamPath)}-${fileStem}`),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (!usedIds.has(candidate)) {
      usedIds.add(candidate);
      return candidate;
    }
  }

  const fallback = `${slugify(fileStem)}-${usedIds.size}`;
  usedIds.add(fallback);
  return fallback;
}

async function ensureDir(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true });
}

async function fetchText(url: string): Promise<string> {
  const response = await fetchWithCurl(url);
  if (!response.ok) {
    throw new Error(
      `GET ${url} failed: ${response.status} ${await response.text()}`,
    );
  }
  return await response.text();
}

async function listUpstreamTopologyPaths(): Promise<string[]> {
  const response = await fetchWithCurl(GITHUB_TREE_URL, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) {
    throw new Error(
      `GitHub tree fetch failed: ${response.status} ${await response.text()}`,
    );
  }

  const payload = await response.json() as { tree?: GitHubTreeItem[] };
  return (payload.tree ?? [])
    .filter((item) =>
      item.type === "blob" &&
      item.path.startsWith(UPSTREAM_PREFIX) &&
      item.path.endsWith(".yaml")
    )
    .map((item) => item.path)
    .sort();
}

function isCompatible(
  nodeDefinitions: string[],
  availableNodeTypes: Set<string>,
): boolean {
  return nodeDefinitions.every((nodeType) => availableNodeTypes.has(nodeType));
}

export async function downloadDevNetTopologies(
  options: DownloadTopologiesOptions,
): Promise<DownloadTopologiesResult> {
  const log = options.log ?? (() => {});
  const repoDir = options.repoDir;
  const topologiesRoot = `${repoDir}/topologies`.replace(/\/+/g, "/");
  const outRoot = `${topologiesRoot}/cisco-devnet`.replace(/\/+/g, "/");
  const catalogPath = `${topologiesRoot}/catalog.json`.replace(/\/+/g, "/");

  await ensureDir(outRoot);

  const upstreamPaths = await listUpstreamTopologyPaths();
  log(`Found ${upstreamPaths.length} upstream topology YAML file(s)`);

  const entries: TopologyCatalogEntry[] = [];
  const usedIds = new Set<string>();
  let downloaded = 0;
  let skippedExisting = 0;
  let excludedIncompatible = 0;
  let excludedSkipped = 0;

  for (const upstreamPath of upstreamPaths) {
    if (SKIP_UPSTREAM_PATHS.has(upstreamPath)) {
      excludedSkipped++;
      log(`  skip (blocklist): ${upstreamPath}`);
      continue;
    }

    const yaml = await fetchText(`${RAW_BASE}/${upstreamPath}`);
    const metadata = parseLabMetadata(yaml);
    const title = metadata.title ??
      upstreamPath.split("/").pop()?.replace(/\.yaml$/i, "") ??
      upstreamPath;

    if (
      metadata.nodeDefinitions.length > 0 &&
      !isCompatible(metadata.nodeDefinitions, options.availableNodeTypes)
    ) {
      excludedIncompatible++;
      log(
        `  skip (node types): ${upstreamPath} needs [${
          metadata.nodeDefinitions.join(", ")
        }]`,
      );
      continue;
    }

    const relativePath = localRelativePath(upstreamPath);
    const localPath = `${repoDir}/topologies/${relativePath}`.replace(
      /\/+/g,
      "/",
    );
    const category = categoryFromPath(upstreamPath);
    const ccnpRelevant = isCcnpRelevant(upstreamPath, category, title);
    const topologyId = assignCatalogId(upstreamPath, title, usedIds);

    if (!options.force) {
      try {
        const existing = await Deno.readTextFile(localPath);
        if (existing === yaml) {
          skippedExisting++;
        } else {
          await Deno.writeTextFile(localPath, yaml);
          downloaded++;
        }
      } catch {
        await ensureDir(localPath.slice(0, localPath.lastIndexOf("/")));
        await Deno.writeTextFile(localPath, yaml);
        downloaded++;
      }
    } else {
      await ensureDir(localPath.slice(0, localPath.lastIndexOf("/")));
      await Deno.writeTextFile(localPath, yaml);
      downloaded++;
    }

    entries.push({
      id: topologyId,
      title,
      description: metadata.description,
      path: relativePath,
      source:
        `https://github.com/CiscoDevNet/cml-community/blob/master/${upstreamPath}`,
      category,
      tags: buildTags(category, ccnpRelevant),
      nodeDefinitions: metadata.nodeDefinitions,
    });
    log(`  kept ${topologyId}: ${title}`);
  }

  entries.sort((a, b) => a.id.localeCompare(b.id));
  const catalog: TopologyCatalog = {
    catalogVersion: 1,
    topologies: entries,
  };

  await Deno.writeTextFile(
    catalogPath,
    `${JSON.stringify(catalog, null, 2)}\n`,
  );
  log(
    `Catalog written: ${entries.length} compatible topologies → ${catalogPath}`,
  );

  return {
    catalog,
    downloaded,
    skippedExisting,
    excludedIncompatible,
    excludedSkipped,
    catalogPath,
  };
}
