/** Topology catalog loader for Cisco DevNet labs shipped in topologies/. */

export type TopologyCatalogEntry = {
  id: string;
  title: string;
  description?: string;
  path: string;
  source?: string;
  category?: string;
  tags?: string[];
  nodeDefinitions?: string[];
};

export type TopologyCatalog = {
  catalogVersion: number;
  topologies: TopologyCatalogEntry[];
};

export async function loadTopologyCatalog(
  repoDir: string,
): Promise<TopologyCatalog> {
  const path = `${repoDir}/topologies/catalog.json`.replace(/\/+/g, "/");
  const text = await Deno.readTextFile(path);
  return JSON.parse(text) as TopologyCatalog;
}

export function findTopology(
  catalog: TopologyCatalog,
  topologyId: string,
): TopologyCatalogEntry {
  const entry = catalog.topologies.find((t) => t.id === topologyId);
  if (!entry) {
    const sample = catalog.topologies.slice(0, 8).map((t) => t.id).join(", ");
    throw new Error(
      `Topology "${topologyId}" not in catalog. Examples: ${sample}`,
    );
  }
  return entry;
}

export function filterTopologies(
  catalog: TopologyCatalog,
  tag?: string,
  category?: string,
): TopologyCatalogEntry[] {
  return catalog.topologies.filter((t) => {
    if (tag && !(t.tags ?? []).includes(tag)) return false;
    if (category && t.category !== category) return false;
    return true;
  });
}
