import { APIGatewayProxyEvent } from 'aws-lambda';

export type Role = 'admin' | 'operator' | 'viewer';

export interface User {
  userId: string;
  role: Role;
  permissions: Permission[];
}

export interface Permission {
  resource: string;
  actions: string[];
}

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: [
    { resource: 'orders', actions: ['read', 'create', 'update', 'delete', 'bulk'] },
    { resource: 'validationResults', actions: ['read', 'create', 'update', 'delete', 'bulk'] },
    { resource: 'correctionHistory', actions: ['read', 'create', 'update', 'delete', 'bulk'] },
    { resource: 'trustScores', actions: ['read', 'create', 'update', 'delete', 'bulk'] },
    { resource: 'ocrResults', actions: ['read', 'create', 'update', 'delete', 'bulk'] },
    { resource: 'voiceGuidance', actions: ['read', 'create', 'update', 'delete', 'bulk'] },
    { resource: 'duplicateDetection', actions: ['read', 'create', 'update', 'delete', 'bulk'] },
    { resource: 'channelDiscrepancy', actions: ['read', 'create', 'update', 'delete', 'bulk'] },
    { resource: 'approvalFlow', actions: ['read', 'create', 'update', 'delete', 'bulk'] },
    { resource: 'approverHistory', actions: ['read', 'create', 'update', 'delete', 'bulk'] },
    { resource: 'integrationLog', actions: ['read', 'create', 'update', 'delete', 'bulk'] },
    { resource: 'users', actions: ['read', 'create', 'update', 'delete', 'bulk'] },
    { resource: 'userPermissions', actions: ['read', 'create', 'update', 'delete', 'bulk'] },
    { resource: 'auditLog', actions: ['read', 'create', 'update', 'delete', 'bulk'] },
    { resource: 'clients', actions: ['read', 'create', 'update', 'delete', 'bulk'] },
    { resource: 'channels', actions: ['read', 'create', 'update', 'delete', 'bulk'] },
    { resource: 'priorityRanks', actions: ['read', 'create', 'update', 'delete', 'bulk'] },
    { resource: 'trustThresholds', actions: ['read', 'create', 'update', 'delete', 'bulk'] },
    { resource: 'validationRules', actions: ['read', 'create', 'update', 'delete', 'bulk'] },
    { resource: 'pastOrderHistory', actions: ['read', 'create', 'update', 'delete', 'bulk'] },
  ],
  operator: [
    { resource: 'orders', actions: ['read', 'create', 'update', 'bulk'] },
    { resource: 'validationResults', actions: ['read', 'create', 'update', 'bulk'] },
    { resource: 'correctionHistory', actions: ['read', 'create', 'update', 'bulk'] },
    { resource: 'trustScores', actions: ['read', 'create', 'update', 'bulk'] },
    { resource: 'ocrResults', actions: ['read', 'create', 'update', 'bulk'] },
    { resource: 'voiceGuidance', actions: ['read', 'create', 'update', 'bulk'] },
    { resource: 'duplicateDetection', actions: ['read', 'create', 'update', 'bulk'] },
    { resource: 'channelDiscrepancy', actions: ['read', 'create', 'update', 'bulk'] },
    { resource: 'approvalFlow', actions: ['read', 'create', 'update', 'bulk'] },
    { resource: 'approverHistory', actions: ['read', 'create', 'update', 'bulk'] },
    { resource: 'integrationLog', actions: ['read', 'create', 'update', 'bulk'] },
    { resource: 'auditLog', actions: ['read', 'create', 'bulk'] },
    { resource: 'clients', actions: ['read'] },
    { resource: 'channels', actions: ['read'] },
    { resource: 'priorityRanks', actions: ['read'] },
    { resource: 'trustThresholds', actions: ['read'] },
    { resource: 'validationRules', actions: ['read'] },
    { resource: 'pastOrderHistory', actions: ['read'] },
  ],
  viewer: [
    { resource: 'orders', actions: ['read'] },
    { resource: 'validationResults', actions: ['read'] },
    { resource: 'correctionHistory', actions: ['read'] },
    { resource: 'trustScores', actions: ['read'] },
    { resource: 'ocrResults', actions: ['read'] },
    { resource: 'voiceGuidance', actions: ['read'] },
    { resource: 'duplicateDetection', actions: ['read'] },
    { resource: 'channelDiscrepancy', actions: ['read'] },
    { resource: 'approvalFlow', actions: ['read'] },
    { resource: 'approverHistory', actions: ['read'] },
    { resource: 'integrationLog', actions: ['read'] },
    { resource: 'clients', actions: ['read'] },
    { resource: 'channels', actions: ['read'] },
    { resource: 'priorityRanks', actions: ['read'] },
    { resource: 'trustThresholds', actions: ['read'] },
    { resource: 'validationRules', actions: ['read'] },
    { resource: 'pastOrderHistory', actions: ['read'] },
  ],
};

export function extractUserFromEvent(event: APIGatewayProxyEvent): User {
  const authHeader = event.headers['Authorization'] || '';
  const token = authHeader.replace('Bearer ', '');
  const role = (token as Role) || 'viewer';
  const userId = event.requestContext?.authorizer?.principalId || 'anonymous';

  return {
    userId,
    role: ['admin', 'operator', 'viewer'].includes(role) ? (role as Role) : 'viewer',
    permissions: ROLE_PERMISSIONS[role as Role] || ROLE_PERMISSIONS.viewer,
  };
}

export function hasPermission(user: User, resource: string, action: string): boolean {
  const permission = user.permissions.find((p) => p.resource === resource);
  return permission ? permission.actions.includes(action) : false;
}

export function requirePermission(user: User, resource: string, action: string): void {
  if (!hasPermission(user, resource, action)) {
    throw new Error(`Forbidden: User does not have ${action} permission on ${resource}`);
  }
}