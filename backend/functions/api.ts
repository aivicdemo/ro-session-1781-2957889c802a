import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  DynamoDBClient,
  BatchWriteItemCommand,
  BatchWriteItemCommandInput,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  ScanCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import {
  extractUserFromEvent,
  buildRBACContext,
  requireRole,
  requirePermission,
  checkUserActive,
} from './rbac';

const client = new DynamoDBClient({ region: 'ap-northeast-1' });
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE || 'order-quality-management';

interface ApiResponse {
  statusCode: number;
  body: string;
}

function response(statusCode: number, data: unknown): ApiResponse {
  return {
    statusCode,
    body: JSON.stringify(data),
  };
}

function errorResponse(statusCode: number, message: string): ApiResponse {
  return response(statusCode, { error: message });
}

async function auditLog(
  userId: string,
  operationType: string,
  targetTable: string,
  targetId: string | undefined,
  details: Record<string, unknown>
): Promise<void> {
  const auditEntry = {
    pk: 'AUDIT',
    sk: `${Date.now()}#${randomUUID()}`,
    userId,
    operationType,
    targetTable,
    targetId,
    details,
    timestamp: new Date().toISOString(),
  };
  
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: auditEntry,
    })
  );
}

// GET /resources - List all resources
async function handleGetResources(
  event: APIGatewayProxyEvent
): Promise<ApiResponse> {
  try {
    const user = extractUserFromEvent(event);
    const context = buildRBACContext(user);
    
    if (!checkUserActive(context)) {
      return errorResponse(403, 'User account is inactive or locked');
    }
    
    if (!requirePermission(context, 'canViewReports')) {
      return errorResponse(403, 'Insufficient permissions to view resources');
    }
    
    const result = await docClient.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        Limit: 100,
      })
    );
    
    return response(200, {
      items: result.Items || [],
      count: result.Count || 0,
    });
  } catch (error) {
    console.error('Error in handleGetResources:', error);
    return errorResponse(500, 'Internal server error');
  }
}

// POST /api/{tableIndex}/bulk - Bulk import endpoint
async function handleBulkImport(
  event: APIGatewayProxyEvent,
  tableIndex: string
): Promise<ApiResponse> {
  try {
    const user = extractUserFromEvent(event);
    const context = buildRBACContext(user);
    
    if (!checkUserActive(context)) {
      return errorResponse(403, 'User account is inactive or locked');
    }
    
    if (!requireRole(context, 'admin', 'operator')) {
      return errorResponse(403, 'Only admin and operator roles can perform bulk import');
    }
    
    const body = JSON.parse(event.body || '{}');
    const items = body.items || [];
    
    if (!Array.isArray(items) || items.length === 0) {
      return errorResponse(400, 'Invalid request: items must be a non-empty array');
    }
    
    const now = new Date().toISOString();
    const enrichedItems = items.map((item: Record<string, unknown>) => ({
      ...item,
      id: item.id || randomUUID(),
      createdAt: item.createdAt || now,
      updatedAt: item.updatedAt || now,
      pk: `${tableIndex}#${item.id || randomUUID()}`,
      sk: `${now}`,
    }));
    
    const chunks: typeof enrichedItems[] = [];
    for (let i = 0; i < enrichedItems.length; i += 25) {
      chunks.push(enrichedItems.slice(i, i + 25));
    }
    
    let imported = 0;
    let failed = 0;
    const errors: string[] = [];
    
    for (const chunk of chunks) {
      const writeRequests = chunk.map((item) => ({
        PutRequest: {
          Item: item,
        },
      }));
      
      const params: BatchWriteItemCommandInput = {
        RequestItems: {
          [TABLE_NAME]: writeRequests,
        },
      };
      
      try {
        await client.send(new BatchWriteItemCommand(params));
        imported += chunk.length;
      } catch (error) {
        failed += chunk.length;
        errors.push(`Batch write failed: ${String(error)}`);
      }
    }
    
    await auditLog(
      user.userId,
      'BULK_IMPORT',
      tableIndex,
      undefined,
      {
        imported,
        failed,
        totalItems: items.length,
      }
    );
    
    return response(200, {
      imported,
      failed,
      errors,
    });
  } catch (error) {
    console.error('Error in handleBulkImport:', error);
    return errorResponse(500, 'Internal server error');
  }
}

// GET /api/{tableIndex}/{id} - Get single resource
async function handleGetResource(
  event: APIGatewayProxyEvent,
  tableIndex: string,
  id: string
): Promise<ApiResponse> {
  try {
    const user = extractUserFromEvent(event);
    const context = buildRBACContext(user);
    
    if (!checkUserActive(context)) {
      return errorResponse(403, 'User account is inactive or locked');
    }
    
    if (!requirePermission(context, 'canViewReports')) {
      return errorResponse(403, 'Insufficient permissions to view resources');
    }
    
    const result = await docClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: `${tableIndex}#${id}`,
          sk: id,
        },
      })
    );
    
    if (!result.Item) {
      return errorResponse(404, 'Resource not found');
    }
    
    return response(200, result.Item);
  } catch (error) {
    console.error('Error in handleGetResource:', error);
    return errorResponse(500, 'Internal server error');
  }
}

// POST /api/{tableIndex} - Create resource
async function handleCreateResource(
  event: APIGatewayProxyEvent,
  tableIndex: string
): Promise<ApiResponse> {
  try {
    const user = extractUserFromEvent(event);
    const context = buildRBACContext(user);
    
    if (!checkUserActive(context)) {
      return errorResponse(403, 'User account is inactive or locked');
    }
    
    if (!requirePermission(context, 'canModifyData')) {
      return errorResponse(403, 'Insufficient permissions to create resources');
    }
    
    const body = JSON.parse(event.body || '{}');
    const id = randomUUID();
    const now = new Date().toISOString();
    
    const item = {
      ...body,
      id,
      pk: `${tableIndex}#${id}`,
      sk: now,
      createdAt: now,
      updatedAt: now,
      createdBy: user.userId,
    };
    
    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: item,
      })
    );
    
    await auditLog(user.userId, 'CREATE', tableIndex, id, { item });
    
    return response(201, item);
  } catch (error) {
    console.error('Error in handleCreateResource:', error);
    return errorResponse(500, 'Internal server error');
  }
}

// PUT /api/{tableIndex}/{id} - Update resource
async function handleUpdateResource(
  event: APIGatewayProxyEvent,
  tableIndex: string,
  id: string
): Promise<ApiResponse> {
  try {
    const user = extractUserFromEvent(event);
    const context = buildRBACContext(user);
    
    if (!checkUserActive(context)) {
      return errorResponse(403, 'User account is inactive or locked');
    }
    
    if (!requirePermission(context, 'canModifyData')) {
      return errorResponse(403, 'Insufficient permissions to update resources');
    }
    
    const body = JSON.parse(event.body || '{}');
    const now = new Date().toISOString();
    
    const updateExpression = Object.keys(body)
      .map((key, index) => `${key} = :val${index}`)
      .join(', ');
    
    const expressionAttributeValues: Record<string, unknown> = {};
    Object.values(body).forEach((value, index) => {
      expressionAttributeValues[`:val${index}`] = value;
    });
    expressionAttributeValues[':updatedAt'] = now;
    expressionAttributeValues[':updatedBy'] = user.userId;
    
    const result = await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: `${tableIndex}#${id}`,
          sk: id,
        },
        UpdateExpression: `${updateExpression}, updatedAt = :updatedAt, updatedBy = :updatedBy`,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: 'ALL_NEW',
      })
    );
    
    await auditLog(user.userId, 'UPDATE', tableIndex, id, { changes: body });
    
    return response(200, result.Attributes);
  } catch (error) {
    console.error('Error in handleUpdateResource:', error);
    return errorResponse(500, 'Internal server error');
  }
}

// DELETE /api/{tableIndex}/{id} - Delete resource
async function handleDeleteResource(
  event: APIGatewayProxyEvent,
  tableIndex: string,
  id: string
): Promise<ApiResponse> {
  try {
    const user = extractUserFromEvent(event);
    const context = buildRBACContext(user);
    
    if (!checkUserActive(context)) {
      return errorResponse(403, 'User account is inactive or locked');
    }
    
    if (!requireRole(context, 'admin')) {
      return errorResponse(403, 'Only admin role can delete resources');
    }
    
    await docClient.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: `${tableIndex}#${id}`,
          sk: id,
        },
      })
    );
    
    await auditLog(user.userId, 'DELETE', tableIndex, id, {});
    
    return response(204, {});
  } catch (error) {
    console.error('Error in handleDeleteResource:', error);
    return errorResponse(500, 'Internal server error');
  }
}

// Main Lambda handler
export async function handler(
  event: APIGatewayProxyEvent
): Promise<ApiResponse> {
  const path = event.path || '';
  const method = event.httpMethod || 'GET';
  
  console.log(`${method} ${path}`);
  
  // GET /resources
  if (method === 'GET' && path === '/resources') {
    return handleGetResources(event);
  }
  
  // POST /api/{tableIndex}/bulk
  const bulkMatch = path.match(/^\/api\/([^\/]+)\/bulk$/);
  if (method === 'POST' && bulkMatch) {
    return handleBulkImport(event, bulkMatch[1]);
  }
  
  // GET /api/{tableIndex}/{id}
  const getMatch = path.match(/^\/api\/([^\/]+)\/([^\/]+)$/);
  if (method === 'GET' && getMatch) {
    return handleGetResource(event, getMatch[1], getMatch[2]);
  }
  
  // POST /api/{tableIndex}
  const createMatch = path.match(/^\/api\/([^\/]+)$/);
  if (method === 'POST' && createMatch) {
    return handleCreateResource(event, createMatch[1]);
  }
  
  // PUT /api/{tableIndex}/{id}
  if (method === 'PUT' && getMatch) {
    return handleUpdateResource(event, getMatch[1], getMatch[2]);
  }
  
  // DELETE /api/{tableIndex}/{id}
  if (method === 'DELETE' && getMatch) {
    return handleDeleteResource(event, getMatch[1], getMatch[2]);
  }
  
  return errorResponse(404, 'Not found');
}