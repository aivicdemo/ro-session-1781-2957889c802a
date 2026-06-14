import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  QueryCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import { extractUserFromEvent, requirePermission } from './rbac';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE || 'order-quality-management';

const TABLES = [
  'orders',
  'validationResults',
  'correctionHistory',
  'trustScores',
  'ocrResults',
  'voiceGuidance',
  'duplicateDetection',
  'channelDiscrepancy',
  'approvalFlow',
  'approverHistory',
  'integrationLog',
  'users',
  'userPermissions',
  'auditLog',
  'clients',
  'channels',
  'priorityRanks',
  'trustThresholds',
  'validationRules',
  'pastOrderHistory',
];

interface AuditLogEntry {
  pk: string;
  sk: string;
  userId: string;
  action: string;
  resource: string;
  itemId?: string;
  details?: Record<string, unknown>;
  timestamp: number;
}

async function createAuditLog(userId: string, action: string, resource: string, itemId?: string, details?: Record<string, unknown>): Promise<void> {
  const auditEntry: AuditLogEntry = {
    pk: 'AUDIT',
    sk: `${Date.now()}#${randomUUID()}`,
    userId,
    action,
    resource,
    itemId,
    details,
    timestamp: Date.now(),
  };
  await docClient.send(new PutCommand({ TableName: TABLE_NAME, Item: auditEntry }));
}

function errorResponse(statusCode: number, message: string): APIGatewayProxyResult {
  return {
    statusCode,
    body: JSON.stringify({ error: message }),
    headers: { 'Content-Type': 'application/json' },
  };
}

function successResponse(statusCode: number, data: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    body: JSON.stringify(data),
    headers: { 'Content-Type': 'application/json' },
  };
}

async function handleGetResources(): Promise<APIGatewayProxyResult> {
  try {
    const resources = TABLES.map((table) => ({
      name: table,
      endpoint: `/api/${TABLES.indexOf(table)}/bulk`,
    }));
    return successResponse(200, { resources });
  } catch (error) {
    console.error('Error fetching resources:', error);
    return errorResponse(500, 'Internal server error');
  }
}

async function handleBulkImport(
  tableIndex: number,
  items: Record<string, unknown>[],
  user: any
): Promise<APIGatewayProxyResult> {
  try {
    if (tableIndex < 0 || tableIndex >= TABLES.length) {
      return errorResponse(400, 'Invalid table index');
    }

    const resource = TABLES[tableIndex];
    requirePermission(user, resource, 'bulk');

    const now = Date.now();
    const enrichedItems = items.map((item) => ({
      ...item,
      pk: resource,
      sk: item.id || randomUUID(),
      id: item.id || randomUUID(),
      createdAt: item.createdAt || now,
      updatedAt: item.updatedAt || now,
      createdBy: item.createdBy || user.userId,
      updatedBy: item.updatedBy || user.userId,
    }));

    const chunks = [];
    for (let i = 0; i < enrichedItems.length; i += 25) {
      chunks.push(enrichedItems.slice(i, i + 25));
    }

    let imported = 0;
    const errors: string[] = [];

    for (const chunk of chunks) {
      const requestItems: Record<string, any[]> = {};
      requestItems[TABLE_NAME] = chunk.map((item) => ({
        PutRequest: {
          Item: item,
        },
      }));

      try {
        await docClient.send(new BatchWriteCommand({ RequestItems: requestItems }));
        imported += chunk.length;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        errors.push(`Batch write failed: ${errorMsg}`);
      }
    }

    await createAuditLog(user.userId, 'BULK_IMPORT', resource, undefined, {
      imported,
      failed: items.length - imported,
      errors,
    });

    return successResponse(200, {
      imported,
      failed: items.length - imported,
      errors,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    if (message.includes('Forbidden')) {
      return errorResponse(403, message);
    }
    console.error('Error in bulk import:', error);
    return errorResponse(500, message);
  }
}

async function handleGetItem(
  tableIndex: number,
  id: string,
  user: any
): Promise<APIGatewayProxyResult> {
  try {
    if (tableIndex < 0 || tableIndex >= TABLES.length) {
      return errorResponse(400, 'Invalid table index');
    }

    const resource = TABLES[tableIndex];
    requirePermission(user, resource, 'read');

    const result = await docClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: resource, sk: id },
      })
    );

    if (!result.Item) {
      return errorResponse(404, 'Item not found');
    }

    return successResponse(200, result.Item);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    if (message.includes('Forbidden')) {
      return errorResponse(403, message);
    }
    console.error('Error fetching item:', error);
    return errorResponse(500, message);
  }
}

async function handleListItems(
  tableIndex: number,
  user: any
): Promise<APIGatewayProxyResult> {
  try {
    if (tableIndex < 0 || tableIndex >= TABLES.length) {
      return errorResponse(400, 'Invalid table index');
    }

    const resource = TABLES[tableIndex];
    requirePermission(user, resource, 'read');

    const result = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': resource },
      })
    );

    return successResponse(200, { items: result.Items || [] });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    if (message.includes('Forbidden')) {
      return errorResponse(403, message);
    }
    console.error('Error listing items:', error);
    return errorResponse(500, message);
  }
}

async function handleCreateItem(
  tableIndex: number,
  item: Record<string, unknown>,
  user: any
): Promise<APIGatewayProxyResult> {
  try {
    if (tableIndex < 0 || tableIndex >= TABLES.length) {
      return errorResponse(400, 'Invalid table index');
    }

    const resource = TABLES[tableIndex];
    requirePermission(user, resource, 'create');

    const now = Date.now();
    const newItem = {
      ...item,
      pk: resource,
      sk: item.id || randomUUID(),
      id: item.id || randomUUID(),
      createdAt: now,
      updatedAt: now,
      createdBy: user.userId,
      updatedBy: user.userId,
    };

    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: newItem,
      })
    );

    await createAuditLog(user.userId, 'CREATE', resource, newItem.sk as string, newItem);

    return successResponse(201, newItem);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    if (message.includes('Forbidden')) {
      return errorResponse(403, message);
    }
    console.error('Error creating item:', error);
    return errorResponse(500, message);
  }
}

async function handleUpdateItem(
  tableIndex: number,
  id: string,
  updates: Record<string, unknown>,
  user: any
): Promise<APIGatewayProxyResult> {
  try {
    if (tableIndex < 0 || tableIndex >= TABLES.length) {
      return errorResponse(400, 'Invalid table index');
    }

    const resource = TABLES[tableIndex];
    requirePermission(user, resource, 'update');

    const now = Date.now();
    const updateExpressionParts: string[] = [];
    const expressionAttributeValues: Record<string, unknown> = {};

    Object.entries(updates).forEach(([key, value], index) => {
      updateExpressionParts.push(`${key} = :val${index}`);
      expressionAttributeValues[`:val${index}`] = value;
    });

    updateExpressionParts.push(`updatedAt = :updatedAt`);
    updateExpressionParts.push(`updatedBy = :updatedBy`);
    expressionAttributeValues[':updatedAt'] = now;
    expressionAttributeValues[':updatedBy'] = user.userId;

    const result = await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { pk: resource, sk: id },
        UpdateExpression: `SET ${updateExpressionParts.join(', ')}`,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: 'ALL_NEW',
      })
    );

    await createAuditLog(user.userId, 'UPDATE', resource, id, updates);

    return successResponse(200, result.Attributes);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    if (message.includes('Forbidden')) {
      return errorResponse(403, message);
    }
    console.error('Error updating item:', error);
    return errorResponse(500, message);
  }
}

async function handleDeleteItem(
  tableIndex: number,
  id: string,
  user: any
): Promise<APIGatewayProxyResult> {
  try {
    if (tableIndex < 0 || tableIndex >= TABLES.length) {
      return errorResponse(400, 'Invalid table index');
    }

    const resource = TABLES[tableIndex];
    requirePermission(user, resource, 'delete');

    await docClient.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { pk: resource, sk: id },
      })
    );

    await createAuditLog(user.userId, 'DELETE', resource, id);

    return successResponse(204, { message: 'Item deleted' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    if (message.includes('Forbidden')) {
      return errorResponse(403, message);
    }
    console.error('Error deleting item:', error);
    return errorResponse(500, message);
  }
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  console.log('Received event:', JSON.stringify(event, null, 2));

  const user = extractUserFromEvent(event);
  const path = event.path || '';
  const method = event.httpMethod || 'GET';

  try {
    if (path === '/resources' && method === 'GET') {
      return await handleGetResources();
    }

    const bulkMatch = path.match(/^\/api\/(\d+)\/bulk$/);
    if (bulkMatch && method === 'POST') {
      const tableIndex = parseInt(bulkMatch[1], 10);
      const body = event.body ? JSON.parse(event.body) : {};
      const items = body.items || [];
      return await handleBulkImport(tableIndex, items, user);
    }

    const getMatch = path.match(/^\/api\/(\d+)\/([a-zA-Z0-9-]+)$/);
    if (getMatch && method === 'GET') {
      const tableIndex = parseInt(getMatch[1], 10);
      const id = getMatch[2];
      return await handleGetItem(tableIndex, id, user);
    }

    const listMatch = path.match(/^\/api\/(\d+)$/);
    if (listMatch && method === 'GET') {
      const tableIndex = parseInt(listMatch[1], 10);
      return await handleListItems(tableIndex, user);
    }

    if (listMatch && method === 'POST') {
      const tableIndex = parseInt(listMatch[1], 10);
      const body = event.body ? JSON.parse(event.body) : {};
      return await handleCreateItem(tableIndex, body, user);
    }

    if (getMatch && method === 'PUT') {
      const tableIndex = parseInt(getMatch[1], 10);
      const id = getMatch[2];
      const body = event.body ? JSON.parse(event.body) : {};
      return await handleUpdateItem(tableIndex, id, body, user);
    }

    if (getMatch && method === 'DELETE') {
      const tableIndex = parseInt(getMatch[1], 10);
      const id = getMatch[2];
      return await handleDeleteItem(tableIndex, id, user);
    }

    return errorResponse(404, 'Not found');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    console.error('Handler error:', error);
    return errorResponse(500, message);
  }
}