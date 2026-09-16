export interface TailscalePolicy {
  tagOwners?: Record<string, string[]>;
  autoApprovers?: {
    routes?: Record<string, string[]>;
    exitNodes?: string[];
  };
  acls?: Array<{
    action: string;
    src: string[];
    dst: string[];
  }>;
  grants?: Array<{
    src: string[];
    dst: string[];
    ip?: string[];
    app?: Record<string, any>;
  }>;
  [key: string]: any;
}

export function mergeTailscalePolicy(
  currentPolicy: TailscalePolicy,
  options: {
    routerTag: string; // e.g. "tag:docker"
    routedSubnet: string; // e.g. "10.128.64.0/24"
    managedPool?: string; // e.g. "10.128.0.0/9"
  },
): { policy: TailscalePolicy; changed: boolean } {
  const policy: TailscalePolicy = JSON.parse(JSON.stringify(currentPolicy || {}));
  let changed = false;

  const tag = options.routerTag.startsWith("tag:")
    ? options.routerTag
    : `tag:${options.routerTag}`;

  // 1. tagOwners
  if (!policy.tagOwners) {
    policy.tagOwners = {};
    changed = true;
  }
  if (!policy.tagOwners[tag]) {
    policy.tagOwners[tag] = ["autogroup:admin"];
    changed = true;
  } else if (!policy.tagOwners[tag].includes("autogroup:admin") && policy.tagOwners[tag].length === 0) {
    policy.tagOwners[tag].push("autogroup:admin");
    changed = true;
  }

  // 2. autoApprovers.routes
  if (!policy.autoApprovers) {
    policy.autoApprovers = {};
    changed = true;
  }
  if (!policy.autoApprovers.routes) {
    policy.autoApprovers.routes = {};
    changed = true;
  }

  const routeTarget = options.managedPool || options.routedSubnet;
  const existingApprovers = policy.autoApprovers.routes[routeTarget];

  if (!existingApprovers) {
    policy.autoApprovers.routes[routeTarget] = [tag];
    changed = true;
  } else if (!existingApprovers.includes(tag)) {
    policy.autoApprovers.routes[routeTarget] = [...existingApprovers, tag];
    changed = true;
  }

  // Also approve the exact routedSubnet if managedPool was specified and differs
  if (options.managedPool && options.routedSubnet !== options.managedPool) {
    const subnetApprovers = policy.autoApprovers.routes[options.routedSubnet];
    if (!subnetApprovers) {
      policy.autoApprovers.routes[options.routedSubnet] = [tag];
      changed = true;
    } else if (!subnetApprovers.includes(tag)) {
      policy.autoApprovers.routes[options.routedSubnet] = [...subnetApprovers, tag];
      changed = true;
    }
  }

  // 3. Access grants / ACL check
  // Check if an accept-all rule already covers access
  const hasWildcardAcl = (policy.acls || []).some(
    (rule) =>
      rule.action === "accept" &&
      rule.src.includes("*") &&
      (rule.dst.includes("*:*") || rule.dst.includes("*")),
  );

  const hasWildcardGrant = (policy.grants || []).some(
    (grant) =>
      grant.src.includes("*") &&
      grant.dst.includes("*"),
  );

  if (!hasWildcardAcl && !hasWildcardGrant) {
    // Check if a grant or ACL for the routedSubnet or tag exists
    const hasRouteGrant = (policy.grants || []).some((grant) =>
      grant.dst.includes(options.routedSubnet),
    );
    if (!hasRouteGrant) {
      if (!policy.grants) policy.grants = [];
      policy.grants.push({
        src: ["autogroup:member"],
        dst: [options.routedSubnet],
        ip: ["*"],
      });
      changed = true;
    }
  }

  return { policy, changed };
}

