/**
 * Functions for extracting tools from an OpenAPI specification
 */
import { OpenAPIV3 } from 'openapi-types';
import type { JSONSchema7, JSONSchema7TypeName } from 'json-schema';
import { generateOperationId } from '../utils/code-gen.js';
import { McpToolDefinition } from '../types/index.js';

/**
 * Extracts tool definitions from an OpenAPI document
 *
 * @param api OpenAPI document
 * @returns Array of MCP tool definitions
 */
export function extractToolsFromApi(api: OpenAPIV3.Document): McpToolDefinition[] {
  const tools: McpToolDefinition[] = [];
  const usedNames = new Set<string>();
  const globalSecurity = api.security || [];
  const securitySchemes = api.components?.securitySchemes || {};

  if (!api.paths) return tools;

  for (const [path, pathItem] of Object.entries(api.paths)) {
    if (!pathItem) continue;

    for (const method of Object.values(OpenAPIV3.HttpMethods)) {
      const operation = pathItem[method];
      if (!operation) continue;

      // Generate a unique name for the tool
      let baseName = operation.operationId || generateOperationId(method, path);
      if (!baseName) continue;

      // Sanitize the name to be MCP-compatible (only a-z, 0-9, _, -)
      baseName = baseName.replace(/\./g, '_').replace(/[^a-z0-9_-]/gi, '_');

      let finalToolName = baseName;
      let counter = 1;
      while (usedNames.has(finalToolName)) {
        finalToolName = `${baseName}_${counter++}`;
      }
      usedNames.add(finalToolName);

      // Get or create a description
      const description =
        operation.description || operation.summary || `Executes ${method.toUpperCase()} ${path}`;

      // Determine security requirements
      const securityRequirements =
        operation.security === null ? globalSecurity : operation.security || globalSecurity;

      // Generate input schema and extract parameters
      const { inputSchema, parameters, requestBodyContentType } =
        generateInputSchemaAndDetails(operation, securityRequirements, securitySchemes);

      // Extract parameter details for execution
      const executionParameters = parameters.map((p) => ({ name: p.name, in: p.in }));

      // Create the tool definition
      tools.push({
        name: finalToolName,
        description,
        inputSchema,
        method,
        pathTemplate: path,
        parameters,
        executionParameters,
        requestBodyContentType,
        securityRequirements,
        operationId: baseName,
      });
    }
  }

  return tools;
}

/**
 * Generates input schema and extracts parameter details from an operation
 *
 * @param operation OpenAPI operation object
 * @param securityRequirements Security requirements for this operation
 * @param securitySchemes Security schemes from the OpenAPI spec
 * @returns Input schema, parameters, and request body content type
 */
export function generateInputSchemaAndDetails(
  operation: OpenAPIV3.OperationObject,
  securityRequirements: OpenAPIV3.SecurityRequirementObject[],
  securitySchemes: Record<string, OpenAPIV3.SecuritySchemeObject | OpenAPIV3.ReferenceObject>
): {
  inputSchema: JSONSchema7 | boolean;
  parameters: OpenAPIV3.ParameterObject[];
  requestBodyContentType?: string;
} {
  const properties: { [key: string]: JSONSchema7 | boolean } = {};
  const required: string[] = [];

  // Process parameters
  const allParameters: OpenAPIV3.ParameterObject[] = Array.isArray(operation.parameters)
    ? operation.parameters.map((p) => p as OpenAPIV3.ParameterObject)
    : [];

  allParameters.forEach((param) => {
    if (!param.name || !param.schema) return;

    const paramSchema = mapOpenApiSchemaToJsonSchema(param.schema as OpenAPIV3.SchemaObject);
    if (typeof paramSchema === 'object') {
      paramSchema.description = param.description || paramSchema.description;
    }

    properties[param.name] = paramSchema;
    if (param.required) required.push(param.name);
  });

  // Process request body (if present)
  let requestBodyContentType: string | undefined = undefined;

  if (operation.requestBody) {
    const opRequestBody = operation.requestBody as OpenAPIV3.RequestBodyObject;
    const jsonContent = opRequestBody.content?.['application/json'];
    const multipartFormContent = opRequestBody.content?.['multipart/form-data'];
    const multipartMixedContent = opRequestBody.content?.['multipart/mixed'];
    const firstContent = opRequestBody.content
      ? Object.entries(opRequestBody.content)[0]
      : undefined;

    if (jsonContent?.schema) {
      requestBodyContentType = 'application/json';
      const bodySchema = mapOpenApiSchemaToJsonSchema(jsonContent.schema as OpenAPIV3.SchemaObject);

      if (typeof bodySchema === 'object') {
        bodySchema.description =
          opRequestBody.description || bodySchema.description || 'The JSON request body.';
      }

      properties['requestBody'] = bodySchema;
      if (opRequestBody.required) required.push('requestBody');
    } else if (multipartFormContent?.schema || multipartMixedContent?.schema) {
      // Handle both multipart/form-data and multipart/mixed
      const multipartContent = multipartFormContent || multipartMixedContent;
      const contentType = multipartFormContent ? 'multipart/form-data' : 'multipart/mixed';

      requestBodyContentType = contentType;
      const multipartSchema = mapOpenApiSchemaToJsonSchema(multipartContent!.schema as OpenAPIV3.SchemaObject);

      // Process multipart schema to handle individual parts
      if (typeof multipartSchema === 'object' && multipartSchema.properties) {
        // Add each multipart field as individual properties
        for (const [fieldName, fieldSchema] of Object.entries(multipartSchema.properties)) {
          if (typeof fieldSchema === 'object' && fieldSchema !== null) {
            const processedSchema = { ...fieldSchema };

            // Special handling for file fields
            if (fieldSchema.type === 'string' && (fieldSchema.format === 'binary' || fieldSchema.format === 'base64')) {
              processedSchema.description = (processedSchema.description || '') +
                ' (Can be a file path or URL - content will be downloaded automatically)';
              processedSchema.type = 'string';
              processedSchema.format = 'file-or-url';
            }

            properties[fieldName] = processedSchema;
          } else {
            properties[fieldName] = fieldSchema;
          }
        }

        // Add required fields from multipart schema
        if (multipartSchema.required && Array.isArray(multipartSchema.required)) {
          required.push(...multipartSchema.required);
        }
      }
    } else if (firstContent) {
      const [contentType] = firstContent;
      requestBodyContentType = contentType;

      properties['requestBody'] = {
        type: 'string',
        description: opRequestBody.description || `Request body (content type: ${contentType})`,
      };

      if (opRequestBody.required) required.push('requestBody');
    }
  }

  // Combine everything into a JSON Schema
  const inputSchema: JSONSchema7 = {
    type: 'object',
    properties,
    ...(required.length > 0 && { required }),
  };

  return { inputSchema, parameters: allParameters, requestBodyContentType };
}

/**
 * Maps an OpenAPI schema to a JSON Schema with cycle protection.
 *
 * @param schema OpenAPI schema object or reference
 * @param seen WeakSet tracking already visited schema objects
 * @returns JSON Schema representation
 */
export function mapOpenApiSchemaToJsonSchema(
  schema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject,
  seen: WeakSet<object> = new WeakSet()
): JSONSchema7 | boolean {
  // Handle reference objects
  if ('$ref' in schema) {
    console.warn(`Unresolved $ref '${schema.$ref}'.`);
    return { type: 'object' };
  }

  // Handle boolean schemas
  if (typeof schema === 'boolean') return schema;

  // Detect cycles
  if (seen.has(schema)) {
    console.warn(
      `Cycle detected in schema${schema.title ? ` "${schema.title}"` : ''}, returning generic object to break recursion.`
    );
    return { type: 'object' };
  }
  seen.add(schema);

  try {
    // Create a copy of the schema to modify
    const jsonSchema: JSONSchema7 = { ...schema } as any;

    // Convert integer type to number (JSON Schema compatible)
    if (schema.type === 'integer') jsonSchema.type = 'number';

    // Remove OpenAPI-specific properties that aren't in JSON Schema
    delete (jsonSchema as any).nullable;
    delete (jsonSchema as any).example;
    delete (jsonSchema as any).xml;
    delete (jsonSchema as any).externalDocs;
    delete (jsonSchema as any).deprecated;
    delete (jsonSchema as any).readOnly;
    delete (jsonSchema as any).writeOnly;

    // Handle nullable properties by adding null to the type
    if (schema.nullable) {
      if (Array.isArray(jsonSchema.type)) {
        if (!jsonSchema.type.includes('null')) jsonSchema.type.push('null');
      } else if (typeof jsonSchema.type === 'string') {
        jsonSchema.type = [jsonSchema.type as JSONSchema7TypeName, 'null'];
      } else if (!jsonSchema.type) {
        jsonSchema.type = 'null';
      }
    }

    // Recursively process object properties
    if (jsonSchema.type === 'object' && jsonSchema.properties) {
      const mappedProps: { [key: string]: JSONSchema7 | boolean } = {};

      for (const [key, propSchema] of Object.entries(jsonSchema.properties)) {
        if (typeof propSchema === 'object' && propSchema !== null) {
          mappedProps[key] = mapOpenApiSchemaToJsonSchema(
            propSchema as OpenAPIV3.SchemaObject,
            seen
          );
        } else if (typeof propSchema === 'boolean') {
          mappedProps[key] = propSchema;
        }
      }

      jsonSchema.properties = mappedProps;
    }

    // Recursively process array items
    if (
      jsonSchema.type === 'array' &&
      typeof jsonSchema.items === 'object' &&
      jsonSchema.items !== null
    ) {
      jsonSchema.items = mapOpenApiSchemaToJsonSchema(
        jsonSchema.items as OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject,
        seen
      );
    }
    return jsonSchema;
  } finally {
    seen.delete(schema);
  }
}
