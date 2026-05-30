import type { DockerProxyConfig } from "./types.js";

const PROXY_ENV_NAMES = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"] as const;
const LOCALHOST_NAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function proxyEnvForContainer(config: DockerProxyConfig | undefined, env: NodeJS.ProcessEnv = process.env): string[] {
  const inheritEnv = config?.inheritEnv ?? true;
  const rewriteLocalhost = config?.rewriteLocalhost ?? true;
  const values = new Map<string, string>();
  if (inheritEnv) {
    for (const name of PROXY_ENV_NAMES) {
      const value = env[name];
      if (value) values.set(name, value);
    }
  }
  setProxyValue(values, "HTTP_PROXY", "http_proxy", config?.http);
  setProxyValue(values, "HTTPS_PROXY", "https_proxy", config?.https);
  setProxyValue(values, "ALL_PROXY", "all_proxy", config?.all);
  setProxyValue(values, "NO_PROXY", "no_proxy", config?.noProxy);
  return [...values.entries()].map(([name, value]) => `${name}=${name.toLowerCase() === "no_proxy" || !rewriteLocalhost ? value : dockerReachableProxy(value)}`);
}

function setProxyValue(values: Map<string, string>, upper: string, lower: string, value: string | undefined): void {
  if (!value) return;
  values.set(upper, value);
  values.delete(lower);
}

export function hasProxyEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.HTTP_PROXY || env.HTTPS_PROXY || env.ALL_PROXY || env.http_proxy || env.https_proxy || env.all_proxy);
}

export function proxyForUrl(input: string | URL, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const url = typeof input === "string" ? new URL(input) : input;
  if (matchesNoProxy(url.hostname, env.NO_PROXY ?? env.no_proxy)) return undefined;
  if (url.protocol === "https:") return env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy;
  if (url.protocol === "http:") return env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy;
  return env.ALL_PROXY || env.all_proxy;
}

export function assertNodeFetchProxySupported(proxyUrl: string): void {
  const protocol = new URL(proxyUrl).protocol;
  if (protocol !== "http:" && protocol !== "https:") throw new Error(`Proxy protocol ${protocol} is not supported by built-in model/web fetch. Use HTTP_PROXY/HTTPS_PROXY for built-in fetch, or use shell.exec with curl for SOCKS proxies.`);
}

function dockerReachableProxy(value: string): string {
  try {
    const url = new URL(value);
    if (LOCALHOST_NAMES.has(url.hostname)) url.hostname = "host.docker.internal";
    return url.toString();
  } catch {
    return value;
  }
}

function matchesNoProxy(hostname: string, noProxy: string | undefined): boolean {
  if (!noProxy) return false;
  const host = hostname.toLowerCase();
  for (const raw of noProxy.split(",")) {
    const item = raw.trim().toLowerCase();
    if (!item) continue;
    if (item === "*") return true;
    const pattern = item.startsWith(".") ? item.slice(1) : item;
    const barePattern = pattern.includes(":") ? pattern.split(":")[0]! : pattern;
    if (host === barePattern || host.endsWith(`.${barePattern}`)) return true;
  }
  return false;
}
