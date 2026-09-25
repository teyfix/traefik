import type { TailscalePolicy } from "./policy";

export interface TailscaleDevice {
  id: string;
  name: string;
  hostname: string;
  tags?: string[];
  addresses: string[];
  advertisedRoutes?: string[];
  enabledRoutes?: string[];
}


export class TailscaleApiError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public responseBody?: string,
  ) {
    super(message);
    this.name = "TailscaleApiError";
  }
}

export class TailscaleApiClient {
  private apiToken: string;
  private baseUrl: string;

  constructor(apiToken?: string, baseUrl = "https://api.tailscale.com/api/v2") {
    const token = apiToken ?? process.env.TS_API_TOKEN;
    if (!token) {
      throw new Error(
        "Tailscale API token missing. Please run with:\nTS_API_TOKEN=\"tskey-api-...\" bun scripts/onboarding.ts ...",
      );
    }
    this.apiToken = token;
    this.baseUrl = baseUrl;
  }

  private sanitize(message: string): string {
    if (!this.apiToken) return message;
    return message.replaceAll(this.apiToken, "[REDACTED_API_TOKEN]");
  }

  private async request<T>(
    path: string,
    options: RequestInit = {},
  ): Promise<{ data: T; headers: Headers }> {
    const url = `${this.baseUrl}${path}`;
    const headers = new Headers(options.headers);
    headers.set("Authorization", `Bearer ${this.apiToken}`);
    if (!headers.has("Accept")) {
      headers.set("Accept", "application/json");
    }

    let response: Response;
    try {
      response = await fetch(url, { ...options, headers });
    } catch (err) {
      const sanitized = this.sanitize((err as Error).message);
      throw new TailscaleApiError(`Network error reaching Tailscale API: ${sanitized}`);
    }

    if (!response.ok) {
      let bodyText = "";
      try {
        bodyText = await response.text();
      } catch {}
      const sanitized = this.sanitize(bodyText);
      throw new TailscaleApiError(
        `Tailscale API error at ${path} (HTTP ${response.status}): ${sanitized}`,
        response.status,
        sanitized,
      );
    }

    // Some endpoints (like DELETE or empty PUT) return empty text or 204
    const text = await response.text();
    let data: T = undefined as any;
    if (text.trim()) {
      try {
        data = JSON.parse(text) as T;
      } catch (err) {
        data = text as unknown as T;
      }
    }

    return { data, headers: response.headers };
  }

  /**
   * Retrieves all devices on the default tailnet with all fields included (routes, addresses, tags).
   */
  async getDevices(): Promise<TailscaleDevice[]> {
    const res = await this.request<{ devices: any[] }>("/tailnet/-/devices?fields=all");
    const rawDevices = res.data.devices || [];
    return rawDevices.map((d) => ({
      id: d.id,
      name: d.name,
      hostname: d.hostname,
      tags: d.tags || d.Tags || [],
      addresses: d.addresses || d.Addresses || [],
      advertisedRoutes: d.AdvertisedRoutes || d.advertisedRoutes || [],
      enabledRoutes: d.EnabledRoutes || d.enabledRoutes || [],
    }));
  }

  /**
   * Retrieves advertised and enabled routes for a specific device.
   */
  async getDeviceRoutes(deviceId: string): Promise<{ advertisedRoutes: string[]; enabledRoutes: string[] }> {
    const res = await this.request<{
      advertisedRoutes?: string[];
      AdvertisedRoutes?: string[];
      enabledRoutes?: string[];
      EnabledRoutes?: string[];
    }>(`/device/${deviceId}/routes`);
    const raw = res.data || {};
    return {
      advertisedRoutes: raw.AdvertisedRoutes || raw.advertisedRoutes || [],
      enabledRoutes: raw.EnabledRoutes || raw.enabledRoutes || [],
    };
  }

  /**
   * Aggregates all advertised and approved subnet routes across all devices on the tailnet.
   */
  async getRoutes(): Promise<string[]> {
    const devices = await this.getDevices();
    const routeSet = new Set<string>();
    for (const d of devices) {
      for (const r of d.advertisedRoutes || []) routeSet.add(r);
      for (const r of d.enabledRoutes || []) routeSet.add(r);
    }
    return Array.from(routeSet);
  }

  /**
   * Retrieves current split DNS configuration (domain -> nameservers[]).
   */
  async getSplitDns(): Promise<Record<string, string[]>> {
    try {
      const res = await this.request<Record<string, string[]>>("/tailnet/-/dns/split-dns");
      return res.data || {};
    } catch (err) {
      if ((err as TailscaleApiError).statusCode === 404) {
        return {};
      }
      throw err;
    }
  }

  /**
   * Updates split DNS with a given domain and nameservers.
   * Uses PATCH to perform a minimal merge without clobbering other split DNS rules.
   */
  async updateSplitDns(domain: string, nameservers: string[]): Promise<void> {
    const cleanDomain = domain.replace(/^\./, "").toLowerCase();
    const payload: Record<string, string[]> = {
      [cleanDomain]: nameservers,
    };

    await this.request("/tailnet/-/dns/split-dns", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  /**
   * Retrieves current tailnet ACL policy and ETag.
   */
  async getPolicy(): Promise<{ policy: TailscalePolicy; etag?: string }> {
    const res = await this.request<TailscalePolicy>("/tailnet/-/acl", {
      headers: { Accept: "application/json" },
    });
    const etag = res.headers.get("etag") ?? undefined;
    return { policy: res.data, etag };
  }

  /**
   * Validates a proposed policy without applying it.
   */
  async validatePolicy(policy: TailscalePolicy): Promise<{ valid: boolean; errors?: string[] }> {
    try {
      const res = await this.request<any>("/tailnet/-/acl/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(policy),
      });

      if (res.data && res.data.message) {
        return { valid: false, errors: [res.data.message] };
      }
      return { valid: true };
    } catch (err) {
      const apiErr = err as TailscaleApiError;
      return {
        valid: false,
        errors: [apiErr.message],
      };
    }
  }

  /**
   * Writes the updated tailnet policy using optimistic concurrency control (ETag).
   */
  async setPolicy(policy: TailscalePolicy, etag?: string): Promise<void> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (etag) {
      headers["If-Match"] = etag;
    }

    await this.request("/tailnet/-/acl", {
      method: "POST",
      headers,
      body: JSON.stringify(policy),
    });
  }

  /** Creates a reusable ephemeral key for unattended router re-registration. */
  async createAuthKey(options: { tag: string; description?: string; expirySeconds?: number }): Promise<string> {
    const tag = options.tag.startsWith("tag:") ? options.tag : `tag:${options.tag}`;
    const payload = {
      capabilities: {
        devices: {
          create: {
            reusable: true,
            ephemeral: true,
            preauthorized: true,
            tags: [tag],
          },
        },
      },
      expirySeconds: options.expirySeconds ?? 7_776_000,
      description: options.description || "Traefik Docker ingress router reusable ephemeral auth key",
    };

    const res = await this.request<{ key: string }>("/tailnet/-/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.data || !res.data.key) {
      throw new TailscaleApiError("Tailscale API did not return an auth key.");
    }

    return res.data.key;
  }
}
