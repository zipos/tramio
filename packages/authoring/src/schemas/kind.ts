// A loose JSON Schema 2020-12 type. We deliberately avoid pulling Ajv's full
// type model into the public surface: this package owns the schemas, and the
// validator (task 2.2) is what turns these into Ajv compiled validators. The
// type below is permissive enough to model every construct we use here
// (`prefixItems`, `propertyNames`, `oneOf`, `if/then/else`, etc.) without
// drifting against future Ajv versions.

export interface JSONSchemaType {
  $schema?: string;
  $id?: string;
  $defs?: Record<string, JSONSchemaType>;
  $ref?: string;
  type?: string | string[];
  enum?: readonly unknown[];
  const?: unknown;
  pattern?: string;
  format?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  items?: JSONSchemaType | boolean;
  prefixItems?: JSONSchemaType[];
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  contains?: JSONSchemaType;
  minContains?: number;
  maxContains?: number;
  properties?: Record<string, JSONSchemaType>;
  patternProperties?: Record<string, JSONSchemaType>;
  additionalProperties?: JSONSchemaType | boolean;
  unevaluatedProperties?: JSONSchemaType | boolean;
  propertyNames?: JSONSchemaType;
  required?: string[];
  minProperties?: number;
  maxProperties?: number;
  dependentRequired?: Record<string, string[]>;
  dependentSchemas?: Record<string, JSONSchemaType>;
  allOf?: JSONSchemaType[];
  anyOf?: JSONSchemaType[];
  oneOf?: JSONSchemaType[];
  not?: JSONSchemaType;
  if?: JSONSchemaType;
  then?: JSONSchemaType;
  else?: JSONSchemaType;
  description?: string;
  title?: string;
  default?: unknown;
  examples?: unknown[];
  [keyword: string]: unknown;
}
