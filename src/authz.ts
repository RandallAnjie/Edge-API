export interface PermissionActionDef {
  action: string;
  label_key: string;
  description_key: string;
  default_roles: string[];
}

export interface PermissionResourceDef {
  resource: string;
  label_key: string;
  actions: Omit<PermissionActionDef, "default_roles">[];
}

const RESOURCES: {
  resource: string;
  label_key: string;
  actions: PermissionActionDef[];
}[] = [
  {
    resource: "channel",
    label_key: "Channel Management",
    actions: [
      {
        action: "read",
        label_key: "Read channels",
        description_key: "View channel lists and details without secrets.",
        default_roles: ["admin"],
      },
      {
        action: "operate",
        label_key: "Operate channels",
        description_key: "Test channels, refresh balances, and enable/disable individual, batch, or tagged channels.",
        default_roles: ["admin"],
      },
      {
        action: "write",
        label_key: "Edit channel routing",
        description_key: "Edit non-sensitive settings such as models, groups, and routing rules.",
        default_roles: ["admin"],
      },
      {
        action: "sensitive_write",
        label_key: "Edit sensitive channel settings",
        description_key: "Create channels or edit keys, base URLs, and overrides.",
        default_roles: [],
      },
      {
        action: "secret_view",
        label_key: "View channel secrets",
        description_key: "Reserved for viewing complete channel keys after secure verification.",
        default_roles: [],
      },
    ],
  },
  {
    resource: "audit",
    label_key: "Audit Logs",
    actions: [
      {
        action: "read",
        label_key: "View other accounts' audit logs",
        description_key: "View audit records from user and admin roles. Root records are always excluded.",
        default_roles: [],
      },
    ],
  },
  {
    resource: "task_plugin",
    label_key: "Task Plugin",
    actions: [
      {
        action: "bind",
        label_key: "Bind task plugins",
        description_key: "List registered task plugins and bind them when creating or editing task plugin channels.",
        default_roles: [],
      },
    ],
  },
];

function grantsFor(roleKey: string, superuser: boolean): Record<string, Record<string, boolean>> {
  const grants: Record<string, Record<string, boolean>> = {};
  for (const resource of RESOURCES) {
    const actions: Record<string, boolean> = {};
    for (const action of resource.actions) {
      actions[action.action] = superuser || action.default_roles.includes(roleKey);
    }
    grants[resource.resource] = actions;
  }
  return grants;
}

export function permissionCatalog(): {
  resources: PermissionResourceDef[];
  roles: {
    key: string;
    name: string;
    built_in: boolean;
    superuser: boolean;
    grants: Record<string, Record<string, boolean>>;
  }[];
} {
  return {
    resources: RESOURCES.map((r) => ({
      resource: r.resource,
      label_key: r.label_key,
      actions: r.actions.map(({ default_roles: _d, ...a }) => a),
    })),
    roles: [
      {
        key: "root",
        name: "Root",
        built_in: true,
        superuser: true,
        grants: grantsFor("root", true),
      },
      {
        key: "admin",
        name: "Admin",
        built_in: true,
        superuser: false,
        grants: grantsFor("admin", false),
      },
    ],
  };
}

export function capabilities(role: number): Record<string, Record<string, boolean>> {
  if (role >= 100) return grantsFor("root", true);
  if (role >= 10) return grantsFor("admin", false);
  const empty: Record<string, Record<string, boolean>> = {};
  for (const resource of RESOURCES) {
    empty[resource.resource] = Object.fromEntries(resource.actions.map((a) => [a.action, false]));
  }
  return empty;
}
