import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  ScanCommand,
  QueryCommand,
  BatchWriteCommand
} from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import { extractUserFromEvent, createRBACContext, requirePermission, requireRole, RBACContext } from './rbac';

const client = new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-1' });
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE || 'order-quality-management';

interface ApiResponse {
  statusCode: number;
  body: string;
  headers?: Record<string, string>;
}

function response(statusCode: number, data: unknown): ApiResponse {
  return {
    statusCode,
    body: JSON.stringify(data),
    headers: { 'Content-Type': 'application/json' }
  };
}

function errorResponse(statusCode: number, message: string, details?: unknown): ApiResponse {
  return response(statusCode, { error: message, details });
}

async function createAuditLog(
  context: RBACContext,
  operation: string,
  targetTable: string,
  targetId: string,
  changes: Record<string, unknown>
): Promise<void> {
  const auditEntry = {
    pk: 'AUDIT',
    sk: `${Date.now()}#${randomUUID()}`,
    userId: context.user.userId,
    userName: context.user.userName,
    operation,
    targetTable,
    targetId,
    changes,
    timestamp: new Date().toISOString(),
    ipAddress: 'unknown'
  };

  await docClient.send(new PutCommand({ TableName: TABLE_NAME, Item: auditEntry }));
}

async function getResources(context: RBACContext): Promise<ApiResponse> {
  try {
    requirePermission(context, 'read:all');

    const result = await docClient.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'attribute_exists(pk) AND pk <> :audit',
        ExpressionAttributeValues: { ':audit': 'AUDIT' },
        Limit: 100
      })
    );

    return response(200, {
      items: result.Items || [],
      count: result.Count || 0,
      scannedCount: result.ScannedCount || 0
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('Forbidden')) {
      return errorResponse(403, 'Access denied');
    }
    return errorResponse(500, 'Internal server error', error instanceof Error ? error.message : 'Unknown error');
  }
}

async function bulkImport(
  context: RBACContext,
  tableIndex: string,
  items: Record<string, unknown>[]
): Promise<ApiResponse> {
  try {
    requireRole(context, 'admin', 'operator');
    requirePermission(context, 'bulk:import');

    if (!Array.isArray(items) || items.length === 0) {
      return errorResponse(400, 'Items array is required and must not be empty');
    }

    const processedItems = items.map((item) => ({
      ...item,
      id: (item.id as string) || randomUUID(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: context.user.userId,
      pk: tableIndex,
      sk: (item.id as string) || randomUUID()
    }));

    const chunks: Record<string, unknown>[][] = [];
    for (let i = 0; i < processedItems.length; i += 25) {
      chunks.push(processedItems.slice(i, i + 25));
    }

    let imported = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const chunk of chunks) {
      try {
        const requestItems: Record<string, unknown>[] = chunk.map((item) => ({
          PutRequest: {
            Item: item
          }
        }));

        await docClient.send(
          new BatchWriteCommand({
            RequestItems: {
              [TABLE_NAME]: requestItems as any
            }
          })
        );

        imported += chunk.length;
      } catch (chunkError) {
        failed += chunk.length;
        errors.push(`Chunk error: ${chunkError instanceof Error ? chunkError.message : 'Unknown error'}`);
      }
    }

    await createAuditLog(context, 'BULK_IMPORT', tableIndex, 'batch', {
      imported,
      failed,
      totalItems: items.length
    });

    return response(200, { imported, failed, errors });
  } catch (error) {
    if (error instanceof Error && error.message.includes('Forbidden')) {
      return errorResponse(403, 'Access denied');
    }
    return errorResponse(500, 'Internal server error', error instanceof Error ? error.message : 'Unknown error');
  }
}

async function getResourceById(
  context: RBACContext,
  tableIndex: string,
  id: string
): Promise<ApiResponse> {
  try {
    requirePermission(context, 'read:all');

    const result = await docClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: tableIndex, sk: id }
      })
    );

    if (!result.Item) {
      return errorResponse(404, 'Resource not found');
    }

    return response(200, result.Item);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Forbidden')) {
      return errorResponse(403, 'Access denied');
    }
    return errorResponse(500, 'Internal server error', error instanceof Error ? error.message : 'Unknown error');
  }
}

async function createResource(
  context: RBACContext,
  tableIndex: string,
  data: Record<string, unknown>
): Promise<ApiResponse> {
  try {
    requirePermission(context, 'write:all');

    const id = randomUUID();
    const now = new Date().toISOString();

    const item = {
      ...data,
      id,
      pk: tableIndex,
      sk: id,
      createdAt: now,
      updatedAt: now,
      createdBy: context.user.userId,
      updatedBy: context.user.userId
    };

    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: item
      })
    );

    await createAuditLog(context, 'CREATE', tableIndex, id, data);

    return response(201, item);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Forbidden')) {
      return errorResponse(403, 'Access denied');
    }
    return errorResponse(500, 'Internal server error', error instanceof Error ? error.message : 'Unknown error');
  }
}

async function updateResource(
  context: RBACContext,
  tableIndex: string,
  id: string,
  data: Record<string, unknown>
): Promise<ApiResponse> {
  try {
    requirePermission(context, 'write:all');

    const now = new Date().toISOString();
    const updateData = {
      ...data,
      updatedAt: now,
      updatedBy: context.user.userId
    };

    const updateExpression = Object.keys(updateData)
      .map((key, index) => `#attr${index} = :val${index}`)
      .join(', ');

    const expressionAttributeNames: Record<string, string> = {};
    const expressionAttributeValues: Record<string, unknown> = {};

    Object.keys(updateData).forEach((key, index) => {
      expressionAttributeNames[`#attr${index}`] = key;
      expressionAttributeValues[`:val${index}`] = updateData[key];
    });

    const result = await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { pk: tableIndex, sk: id },
        UpdateExpression: `SET ${updateExpression}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: 'ALL_NEW'
      })
    );

    await createAuditLog(context, 'UPDATE', tableIndex, id, data);

    return response(200, result.Attributes);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Forbidden')) {
      return errorResponse(403, 'Access denied');
    }
    return errorResponse(500, 'Internal server error', error instanceof Error ? error.message : 'Unknown error');
  }
}

async function deleteResource(
  context: RBACContext,
  tableIndex: string,
  id: string
): Promise<ApiResponse> {
  try {
    requirePermission(context, 'delete:all');

    await docClient.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { pk: tableIndex, sk: id }
      })
    );

    await createAuditLog(context, 'DELETE', tableIndex, id, {});

    return response(204, { message: 'Deleted successfully' });
  } catch (error) {
    if (error instanceof Error && error.message.includes('Forbidden')) {
      return errorResponse(403, 'Access denied');
    }
    return errorResponse(500, 'Internal server error', error instanceof Error ? error.message : 'Unknown error');
  }
}

export async function handler(event: APIGatewayProxyEvent): Promise<ApiResponse> {
  const user = extractUserFromEvent(event);
  const context = createRBACContext(user);

  if (!context.isAuthorized) {
    return errorResponse(401, 'Unauthorized');
  }

  const path = event.path || '';
  const method = event.httpMethod || 'GET';
  const pathParts = path.split('/').filter(Boolean);

  try {
    if (path === '/resources' && method === 'GET') {
      return await getResources(context);
    }

    if (pathParts[0] === 'api' && pathParts[2] === 'bulk' && method === 'POST') {
      const tableIndex = pathParts[1];
      const body = JSON.parse(event.body || '{}');
      return await bulkImport(context, tableIndex, body.items || []);
    }

    if (pathParts[0] === 'api' && pathParts[2] && !pathParts[3] && method === 'GET') {
      const tableIndex = pathParts[1];
      const id = pathParts[2];
      return await getResourceById(context, tableIndex, id);
    }

    if (pathParts[0] === 'api' && pathParts[1] && !pathParts[2] && method === 'POST') {
      const tableIndex = pathParts[1];
      const body = JSON.parse(event.body || '{}');
      return await createResource(context, tableIndex, body);
    }

    if (pathParts[0] === 'api' && pathParts[2] && !pathParts[3] && method === 'PUT') {
      const tableIndex = pathParts[1];
      const id = pathParts[2];
      const body = JSON.parse(event.body || '{}');
      return await updateResource(context, tableIndex, id, body);
    }

    if (pathParts[0] === 'api' && pathParts[2] && !pathParts[3] && method === 'DELETE') {
      const tableIndex = pathParts[1];
      const id = pathParts[2];
      return await deleteResource(context, tableIndex, id);
    }

    return errorResponse(404, 'Not found');
  } catch (error) {
    if (error instanceof Error && error.message.includes('Forbidden')) {
      return errorResponse(403, 'Access denied');
    }
    return errorResponse(500, 'Internal server error', error instanceof Error ? error.message : 'Unknown error');
  }
}