import { APIGatewayProxyEvent } from 'aws-lambda';

export type Role = 'admin' | 'operator' | 'viewer';

export interface User {
  userId: string;
  userName: string;
  role: Role;
  isActive: boolean;
  isAccountLocked: boolean;
}

export interface RBACContext {
  user: User;
  isAuthorized: boolean;
  permissions: Set<string>;
}

const rolePermissions: Record<Role, Set<string>> = {
  admin: new Set([
    'read:all',
    'write:all',
    'delete:all',
    'approve:all',
    'audit:read',
    'bulk:import',
    'user:manage',
    'system:config'
  ]),
  operator: new Set([
    'read:all',
    'write:own',
    'write:validation',
    'approve:own',
    'audit:read',
    'bulk:import'
  ]),
  viewer: new Set([
    'read:all',
    'audit:read'
  ])
};

export function extractUserFromEvent(event: APIGatewayProxyEvent): User | null {
  try {
    const authHeader = event.headers['Authorization'] || event.headers['authorization'];
    if (!authHeader) return null;

    const token = authHeader.replace('Bearer ', '');
    const decoded = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());

    return {
      userId: decoded.userId || decoded.sub,
      userName: decoded.userName || decoded.name,
      role: (decoded.role || 'viewer') as Role,
      isActive: decoded.isActive !== false,
      isAccountLocked: decoded.isAccountLocked === true
    };
  } catch (error) {
    return null;
  }
}

export function createRBACContext(user: User | null): RBACContext {
  if (!user || !user.isActive || user.isAccountLocked) {
    return {
      user: user || { userId: '', userName: '', role: 'viewer', isActive: false, isAccountLocked: false },
      isAuthorized: false,
      permissions: new Set()
    };
  }

  return {
    user,
    isAuthorized: true,
    permissions: rolePermissions[user.role]
  };
}

export function hasPermission(context: RBACContext, permission: string): boolean {
  return context.isAuthorized && context.permissions.has(permission);
}

export function requirePermission(context: RBACContext, permission: string): void {
  if (!hasPermission(context, permission)) {
    throw new Error(`Forbidden: Missing permission ${permission}`);
  }
}

export function requireRole(context: RBACContext, ...roles: Role[]): void {
  if (!context.isAuthorized || !roles.includes(context.user.role)) {
    throw new Error(`Forbidden: Required role not found`);
  }
}