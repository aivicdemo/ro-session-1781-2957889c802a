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
  permissions: {
    canValidateData: boolean;
    canModifyData: boolean;
    canApprove: boolean;
    canViewReports: boolean;
    canManageUsers: boolean;
    canModifySystemSettings: boolean;
  };
}

const rolePermissions: Record<Role, RBACContext['permissions']> = {
  admin: {
    canValidateData: true,
    canModifyData: true,
    canApprove: true,
    canViewReports: true,
    canManageUsers: true,
    canModifySystemSettings: true,
  },
  operator: {
    canValidateData: true,
    canModifyData: true,
    canApprove: false,
    canViewReports: true,
    canManageUsers: false,
    canModifySystemSettings: false,
  },
  viewer: {
    canValidateData: false,
    canModifyData: false,
    canApprove: false,
    canViewReports: true,
    canManageUsers: false,
    canModifySystemSettings: false,
  },
};

export function extractUserFromEvent(event: APIGatewayProxyEvent): User {
  const authHeader = event.headers['Authorization'] || '';
  const token = authHeader.replace('Bearer ', '');
  
  // Mock user extraction from token
  // In production, validate JWT and extract claims
  const mockUsers: Record<string, User> = {
    'admin-token': {
      userId: 'user-001',
      userName: 'admin-user',
      role: 'admin',
      isActive: true,
      isAccountLocked: false,
    },
    'operator-token': {
      userId: 'user-002',
      userName: 'operator-user',
      role: 'operator',
      isActive: true,
      isAccountLocked: false,
    },
    'viewer-token': {
      userId: 'user-003',
      userName: 'viewer-user',
      role: 'viewer',
      isActive: true,
      isAccountLocked: false,
    },
  };
  
  return mockUsers[token] || {
    userId: 'unknown',
    userName: 'unknown',
    role: 'viewer',
    isActive: false,
    isAccountLocked: true,
  };
}

export function buildRBACContext(user: User): RBACContext {
  return {
    user,
    permissions: rolePermissions[user.role],
  };
}

export function requireRole(context: RBACContext, ...roles: Role[]): boolean {
  return roles.includes(context.user.role);
}

export function requirePermission(
  context: RBACContext,
  permission: keyof RBACContext['permissions']
): boolean {
  return context.permissions[permission];
}

export function checkUserActive(context: RBACContext): boolean {
  return context.user.isActive && !context.user.isAccountLocked;
}