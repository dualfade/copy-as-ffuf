import type { Caido } from "@caido/sdk-frontend";

type HeaderPair = [string, string];

function escapeDoubleQuotes(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeSingleQuotesForShell(value: string): string {
  return value.replace(/'/g, `'\\''`);
}

function fuzzQuery(query: string): string {
  if (!query) return "";
  return query.replace(/(^|&)([^=]+)=([^&]*)/g, "$1$2=FUZZ");
}

function parseRawRequest(raw: string): {
  method: string;
  target: string;
  headers: HeaderPair[];
  body: string;
} {
  const normalized = raw.replace(/\r\n/g, "\n");
  const splitIndex = normalized.indexOf("\n\n");

  const head = splitIndex === -1 ? normalized : normalized.slice(0, splitIndex);
  const body = splitIndex === -1 ? "" : normalized.slice(splitIndex + 2);

  const lines = head.split("\n");
  const requestLine = lines.shift() || "";
  const match = requestLine.match(/^([A-Z]+)\s+(\S+)\s+HTTP\/\d\.\d$/);

  if (!match) {
    throw new Error("Could not parse HTTP request line");
  }

  const [, method, target] = match;
  const headers: HeaderPair[] = [];

  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;

    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();

    if (!name) continue;
    headers.push([name, value]);
  }

  return { method, target, headers, body };
}

function buildAbsoluteUrl(target: string, headers: HeaderPair[]): string {
  if (/^https?:\/\//i.test(target)) {
    const url = new URL(target);
    if (url.search) {
      url.search = "?" + fuzzQuery(url.search.slice(1));
    }
    return url.toString();
  }

  const hostHeader = headers.find(([name]) => /^host$/i.test(name))?.[1];
  if (!hostHeader) {
    throw new Error("Missing Host header");
  }

  const [path, query = ""] = target.split("?", 2);
  const fuzzedQuery = fuzzQuery(query);

  return `https://${hostHeader}${path}${fuzzedQuery ? `?${fuzzedQuery}` : ""}`;
}

function replaceJsonWithFuzz(body: string): string {
  try {
    const parsed = JSON.parse(body);

    const walk = (value: unknown): unknown => {
      if (value === null) return "FUZZ";

      if (Array.isArray(value)) {
        return value.map(walk);
      }

      if (typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          out[k] = walk(v);
        }
        return out;
      }

      return "FUZZ";
    };

    return JSON.stringify(walk(parsed));
  } catch {
    return body;
  }
}

function getHeaderValues(headers: HeaderPair[], headerName: string): string[] {
  return headers
    .filter(([name]) => name.toLowerCase() === headerName.toLowerCase())
    .map(([, value]) => value);
}

function shouldKeepMinimalHeader(name: string, body: string): boolean {
  const n = name.toLowerCase();

  if (n === "authorization") return true;
  if (n === "cookie") return true;
  if (n === "x-csrf-token") return true;
  if (n === "x-xsrf-token") return true;
  if (n === "csrf-token") return true;
  if (n === "origin") return true;
  if (n === "referer") return true;
  if (n === "accept") return true;

  if (n === "content-type" && body.length > 0) return true;

  return false;
}

function buildFfufCore(raw: string, minimalHeaders = true): string {
  const { method, target, headers, body } = parseRawRequest(raw);
  const url = buildAbsoluteUrl(target, headers);

  let cmd = `ffuf -u "${escapeDoubleQuotes(url)}" -X ${method}`;

  for (const [name, value] of headers) {
    if (/^(host|content-length|connection|accept-encoding)$/i.test(name)) {
      continue;
    }

    if (minimalHeaders && !shouldKeepMinimalHeader(name, body)) {
      continue;
    }

    cmd += ` \\\n  -H "${escapeDoubleQuotes(name)}: ${escapeDoubleQuotes(value)}"`;
  }

  if (body) {
    const contentType = getHeaderValues(headers, "Content-Type").join("; ").toLowerCase();

    let outputBody = body;
    if (contentType.includes("application/json")) {
      outputBody = replaceJsonWithFuzz(body);
    }

    cmd += ` \\\n  -d '${escapeSingleQuotesForShell(outputBody)}'`;
  }

  cmd += ` \\\n  -mc all`;

  return cmd;
}

function buildFfufCommand(raw: string, minimalHeaders: boolean): string {
  const core = buildFfufCore(raw, minimalHeaders);
  return `${core} \\\n  -w /path/to/wordlist.txt`;
}

function buildEncodedFfufCommand(raw: string, minimalHeaders: boolean): string {
  const core = buildFfufCore(raw, minimalHeaders);
  return `pencode -input /path/to/wordlist.txt urlencode | ${core} \\\n  -w -`;
}

async function copyRequestAsFfuf(
  sdk: Caido,
  context: unknown,
  variant: "minimal" | "full" | "encoded",
): Promise<void> {
  const typedContext = context as { type?: string; request?: { raw?: string } };

  if (typedContext.type !== "RequestContext") {
    sdk.window.showToast("Open a request first.", { variant: "warning" });
    return;
  }

  const raw = typedContext.request?.raw;

  if (typeof raw !== "string" || !raw.length) {
    throw new Error("This request does not expose raw content");
  }

  let cmd = "";
  let successMessage = "";

  if (variant === "minimal") {
    cmd = buildFfufCommand(raw, true);
    successMessage = "Minimal FFUF command copied to clipboard";
  } else if (variant === "full") {
    cmd = buildFfufCommand(raw, false);
    successMessage = "FFUF command with full headers copied to clipboard";
  } else {
    cmd = buildEncodedFfufCommand(raw, true);
    successMessage = "Encoded FFUF command copied to clipboard";
  }

  await navigator.clipboard.writeText(cmd);
  sdk.window.showToast(successMessage, { variant: "success" });
}

export function init(sdk: Caido) {
  sdk.commands.register("copy-as-ffuf", {
    name: "Copy as FFUF ( Minimal Headers )",
    group: "Custom Commands",
    when: (context) => context.type === "RequestContext",
    run: async (context) => {
      try {
        await copyRequestAsFfuf(sdk, context, "minimal");
      } catch (err: unknown) {
        console.error("copy-as-ffuf error:", err);
        sdk.window.showToast(
          err instanceof Error ? err.message : "Failed to generate FFUF command",
          { variant: "error" },
        );
      }
    },
  });

  sdk.commands.register("copy-as-ffuf-full", {
    name: "Copy as FFUF (Full Headers)",
    group: "Custom Commands",
    when: (context) => context.type === "RequestContext",
    run: async (context) => {
      try {
        await copyRequestAsFfuf(sdk, context, "full");
      } catch (err: unknown) {
        console.error("copy-as-ffuf-full error:", err);
        sdk.window.showToast(
          err instanceof Error ? err.message : "Failed to generate FFUF command",
          { variant: "error" },
        );
      }
    },
  });

  sdk.commands.register("copy-as-ffuf-encoded", {
    name: "Copy as FFUF (Encoded Wordlist; requires pencode)",
    group: "Custom Commands",
    when: (context) => context.type === "RequestContext",
    run: async (context) => {
      try {
        await copyRequestAsFfuf(sdk, context, "encoded");
      } catch (err: unknown) {
        console.error("copy-as-ffuf-encoded error:", err);
        sdk.window.showToast(
          err instanceof Error ? err.message : "Failed to generate encoded FFUF command",
          { variant: "error" },
        );
      }
    },
  });

  sdk.menu.registerItem({
    type: "Request",
    commandId: "copy-as-ffuf",
    leadingIcon: "fas fa-terminal",
  });

  sdk.menu.registerItem({
    type: "Request",
    commandId: "copy-as-ffuf-full",
    leadingIcon: "fas fa-terminal",
  });

  sdk.menu.registerItem({
    type: "Request",
    commandId: "copy-as-ffuf-encoded",
    leadingIcon: "fas fa-terminal",
  });
}
