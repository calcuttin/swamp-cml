/** CML REST API helpers for @calcuttin/cml extension models. */

export type CmlFetchOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  skipTlsVerify?: boolean;
};

export async function fetchWithCurl(
  url: string,
  options: CmlFetchOptions = {},
) {
  const { method = "GET", headers = {}, body, skipTlsVerify } = options;

  const args = ["-s", "-S"];
  if (skipTlsVerify) {
    args.push("-k");
  }
  args.push("-X", method);
  for (const [key, value] of Object.entries(headers)) {
    args.push("-H", `${key}: ${value}`);
  }
  if (body) {
    args.push("-d", body);
  }
  args.push("-i", url);

  // @ts-ignore Deno API
  const command = new Deno.Command("curl", { args });
  const { code, stdout, stderr } = await command.output();
  if (code !== 0) {
    throw new Error(
      `curl failed with code ${code}: ${new TextDecoder().decode(stderr)}`,
    );
  }

  const output = new TextDecoder().decode(stdout);
  const headerEndIndex = output.indexOf("\r\n\r\n");
  const headersText = output.substring(0, headerEndIndex);
  const bodyText = output.substring(headerEndIndex + 4);
  const statusLine = headersText.split("\r\n")[0];
  const statusMatch = statusLine.match(/HTTP\/[\d.]+ (\d+)/);
  const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;

  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: statusLine,
    text: () => bodyText,
    json: () => JSON.parse(bodyText),
  };
}

export type CmlAuthArgs = {
  baseUrl: string;
  skipTlsVerify?: boolean;
  token?: string;
  username?: string;
  password?: string;
};

function apiBase(args: CmlAuthArgs): string {
  return args.baseUrl.replace(/\/$/, "");
}

function authHeaders(token: string, extra: Record<string, string> = {}) {
  return {
    "Authorization": `Bearer ${token}`,
    ...extra,
  };
}

export async function resolveCmlToken(args: CmlAuthArgs): Promise<string> {
  if (args.token?.trim()) {
    return args.token.trim().replace(/^"|"$/g, "");
  }

  const username = args.username?.trim();
  const password = args.password;
  if (!username || password === undefined || password === "") {
    throw new Error(
      "No CML auth available: set token or username/password (via vault).",
    );
  }

  const response = await fetchWithCurl(
    `${apiBase(args)}/api/v0/authenticate`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({ username, password }),
      skipTlsVerify: args.skipTlsVerify ?? true,
    },
  );

  if (!response.ok) {
    throw new Error(
      `CML authentication failed: ${response.status} ${await response.text()}`,
    );
  }

  return (await response.text()).trim().replace(/^"|"$/g, "");
}

export async function cmlRequest<T = unknown>(
  args: CmlAuthArgs,
  token: string,
  path: string,
  options: Omit<CmlFetchOptions, "skipTlsVerify"> & {
    accept?: string;
    contentType?: string;
  } = {},
): Promise<T> {
  const {
    accept = "application/json",
    contentType = "application/json",
    ...rest
  } = options;
  const response = await fetchWithCurl(`${apiBase(args)}${path}`, {
    ...rest,
    skipTlsVerify: args.skipTlsVerify ?? true,
    headers: {
      "Accept": accept,
      ...(rest.body ? { "Content-Type": contentType } : {}),
      ...authHeaders(token, rest.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(
      `CML ${
        options.method ?? "GET"
      } ${path} failed: ${response.status} ${await response.text()}`,
    );
  }

  const text = await response.text();
  if (!text.trim()) {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}

export type CmlLabDetail = {
  id: string;
  lab_title: string;
  state?: string;
  lab_description?: string;
  lab_notes?: string;
  node_count?: number;
  link_count?: number;
  owner_username?: string;
  created?: string;
  modified?: string;
  autostart?: { enabled?: boolean };
  node_staging?: {
    enabled?: boolean;
    start_remaining?: boolean;
  };
};

export type CmlNodeDetail = {
  id: string;
  label: string;
  node_definition?: string;
  state?: string;
  x?: number;
  y?: number;
  hide_links?: boolean;
  ram?: number;
  cpus?: number;
  interfaces?: Array<{ id: string; label: string; type?: string }>;
};

export type CmlLinkDetail = {
  id: string;
  label?: string;
  state?: string;
  n1?: string;
  n2?: string;
  i1?: string;
  i2?: string;
};

export type CmlSystemInfo = {
  version?: string;
  ready?: boolean;
  features?: string[];
};

export type CmlLabSnapshot = {
  lab: CmlLabDetail;
  nodes: CmlNodeDetail[];
  links: CmlLinkDetail[];
};

export async function getSystemInformation(
  args: CmlAuthArgs,
  token: string,
): Promise<CmlSystemInfo> {
  return await cmlRequest<CmlSystemInfo>(
    args,
    token,
    "/api/v0/system_information",
  );
}

export async function listLabIds(
  args: CmlAuthArgs,
  token: string,
): Promise<string[]> {
  return await cmlRequest<string[]>(args, token, "/api/v0/labs");
}

export async function getLab(
  args: CmlAuthArgs,
  token: string,
  labId: string,
): Promise<CmlLabDetail> {
  return await cmlRequest<CmlLabDetail>(args, token, `/api/v0/labs/${labId}`);
}

async function listEntityIds(
  args: CmlAuthArgs,
  token: string,
  path: string,
): Promise<string[]> {
  return await cmlRequest<string[]>(args, token, path);
}

export async function getLabNode(
  args: CmlAuthArgs,
  token: string,
  labId: string,
  nodeId: string,
): Promise<CmlNodeDetail> {
  return await cmlRequest<CmlNodeDetail>(
    args,
    token,
    `/api/v0/labs/${labId}/nodes/${nodeId}`,
  );
}

export async function getLabLink(
  args: CmlAuthArgs,
  token: string,
  labId: string,
  linkId: string,
): Promise<CmlLinkDetail> {
  return await cmlRequest<CmlLinkDetail>(
    args,
    token,
    `/api/v0/labs/${labId}/links/${linkId}`,
  );
}

export async function collectLabSnapshot(
  args: CmlAuthArgs,
  token: string,
  labId: string,
): Promise<CmlLabSnapshot> {
  const lab = await getLab(args, token, labId);
  lab.id = lab.id ?? labId;

  const nodeIds = await listEntityIds(
    args,
    token,
    `/api/v0/labs/${labId}/nodes`,
  );
  const linkIds = await listEntityIds(
    args,
    token,
    `/api/v0/labs/${labId}/links`,
  );

  const nodes: CmlNodeDetail[] = [];
  for (const nodeId of nodeIds) {
    nodes.push(await getLabNode(args, token, labId, nodeId));
  }

  const links: CmlLinkDetail[] = [];
  for (const linkId of linkIds) {
    links.push(await getLabLink(args, token, labId, linkId));
  }

  nodes.sort((a, b) => a.label.localeCompare(b.label));
  links.sort((a, b) => (a.label ?? a.id).localeCompare(b.label ?? b.id));

  return { lab, nodes, links };
}

export async function createLab(
  args: CmlAuthArgs,
  token: string,
  title: string,
  description = "",
): Promise<CmlLabDetail> {
  return await cmlRequest<CmlLabDetail>(args, token, "/api/v0/labs", {
    method: "POST",
    body: JSON.stringify({
      title,
      description,
    }),
  });
}

export async function deleteLab(
  args: CmlAuthArgs,
  token: string,
  labId: string,
): Promise<void> {
  await cmlRequest(args, token, `/api/v0/labs/${labId}`, {
    method: "DELETE",
  });
}

export async function importLabYaml(
  args: CmlAuthArgs,
  token: string,
  yaml: string,
  title?: string,
): Promise<{ id: string; warnings?: string[] }> {
  const query = title ? `?title=${encodeURIComponent(title)}` : "";
  const response = await fetchWithCurl(
    `${apiBase(args)}/api/v0/import${query}`,
    {
      method: "POST",
      skipTlsVerify: args.skipTlsVerify ?? true,
      headers: authHeaders(token, {
        "Content-Type": "application/yaml",
        "Accept": "application/json",
      }),
      body: yaml,
    },
  );

  if (!response.ok) {
    throw new Error(
      `CML import failed: ${response.status} ${await response.text()}`,
    );
  }

  return await response.json();
}

export async function startLab(
  args: CmlAuthArgs,
  token: string,
  labId: string,
): Promise<void> {
  await cmlRequest(args, token, `/api/v0/labs/${labId}/start`, {
    method: "PUT",
  });
}

export async function stopLab(
  args: CmlAuthArgs,
  token: string,
  labId: string,
): Promise<void> {
  await cmlRequest(args, token, `/api/v0/labs/${labId}/stop`, {
    method: "PUT",
  });
}

export async function wipeLab(
  args: CmlAuthArgs,
  token: string,
  labId: string,
): Promise<void> {
  await cmlRequest(args, token, `/api/v0/labs/${labId}/wipe`, {
    method: "PUT",
  });
}

export async function listNodeDefinitionIds(
  args: CmlAuthArgs,
  token: string,
): Promise<string[]> {
  const defs = await cmlRequest<Array<{ id: string }>>(
    args,
    token,
    "/api/v0/node_definitions",
  );
  return defs.map((def) => def.id).sort();
}

export async function findLabByTitle(
  args: CmlAuthArgs,
  token: string,
  title: string,
): Promise<CmlLabDetail | null> {
  const ids = await listLabIds(args, token);
  for (const id of ids) {
    const lab = await getLab(args, token, id);
    if (lab.lab_title === title) {
      return { ...lab, id };
    }
  }
  return null;
}

export function sanitizeResourceName(title: string): string {
  return title.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") ||
    "lab";
}

export function nodeResourceName(labTitle: string, nodeLabel: string): string {
  return `${sanitizeResourceName(labTitle)}--${
    sanitizeResourceName(nodeLabel)
  }`;
}

export function linkResourceName(labTitle: string, linkId: string): string {
  return `${sanitizeResourceName(labTitle)}--link-${linkId.slice(0, 8)}`;
}
