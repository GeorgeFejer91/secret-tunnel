// Versioned public receipt contract. Dependency-free; shared by the transport,
// MCP schema adapter and tests. Never forward arbitrary broker fields.
const string = (maxLength, pattern) => ({ type: 'string', maxLength, ...(pattern ? { pattern } : {}) });
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
const array = (items, maxItems) => ({ type: 'array', items, maxItems });
const object = (properties, optional = []) => ({ type: 'object', properties,
  required: Object.keys(properties).filter(key => !optional.includes(key)), additionalProperties: false });
const oid = string(40, '^[a-f0-9]{40}$');
const safeCode = string(100, '^[a-z][a-z0-9_]*$');
const timestamp = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const repositoryUrl = string(2048, '^https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$');
const expectedSchema = object({
  workspaceFingerprint: string(128), localHead: nullable(oid), branch: nullable(string(512)),
  remoteTip: nullable(oid), contentDigest: nullable(string(128)), accountLogin: nullable(string(100)),
  publication: nullable(object({ remote: string(100), url: repositoryUrl,
    repository: string(205), branch: string(512) }))
});
export const githubReceiptSchema = object({
  schemaVersion: { type: 'integer', const: 1 },
  operationId: string(37, '^plan-[a-f0-9]{32}$'),
  instanceId: string(32, '^[a-f0-9]{32}$'),
  action: { type: 'string', enum: ['commit', 'commit_push', 'push', 'create_repository'] },
  state: { type: 'string', enum: ['running', 'succeeded', 'partial', 'failed', 'unknown'] },
  phase: safeCode,
  startedAtSecs: timestamp, updatedAtSecs: timestamp,
  commit: nullable(object({
    beforeHead: nullable(oid), afterHead: oid,
    committedPaths: array(string(512), 50),
    pushed: nullable(object({
      remote: string(100), branch: string(512), pushedHead: oid,
      verifiedRemoteHead: nullable(oid), repository: nullable(string(205, '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'))
    }))
  }, ['pushed'])),
  createdRepository: nullable(object({
    fullName: string(205, '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
    htmlUrl: repositoryUrl, cloneUrl: repositoryUrl,
    private: { type: 'boolean' }, defaultBranch: string(512)
  })),
  setup: array(object({ name: safeCode, state: safeCode, errorCode: nullable(safeCode) }), 10),
  errorCode: nullable(safeCode),
  expected: nullable(expectedSchema)
}, ['expected']);

export function projectSchema(schema, value) {
  if (schema.anyOf) {
    for (const candidate of schema.anyOf) {
      try { return projectSchema(candidate, value); } catch { /* try the next declared variant */ }
    }
    throw new TypeError('No supported result variant.');
  }
  if (Object.hasOwn(schema, 'const') && value !== schema.const) throw new TypeError('Unsupported contract version.');
  if (schema.enum && !schema.enum.includes(value)) throw new TypeError('Unknown result enum.');
  switch (schema.type) {
    case 'null': if (value !== null) throw new TypeError('Expected null.'); return null;
    case 'boolean': if (typeof value !== 'boolean') throw new TypeError('Expected boolean.'); return value;
    case 'integer':
      if (!Number.isSafeInteger(value) || (schema.minimum !== undefined && value < schema.minimum)
        || (schema.maximum !== undefined && value > schema.maximum)) throw new TypeError('Invalid integer.');
      return value;
    case 'string':
      if (typeof value !== 'string' || value.length > schema.maxLength
        || (schema.pattern && !new RegExp(schema.pattern).test(value))) throw new TypeError('Invalid string.');
      return value;
    case 'array':
      if (!Array.isArray(value) || value.length > schema.maxItems) throw new TypeError('Invalid result list.');
      return value.map(item => projectSchema(schema.items, item));
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('Invalid result object.');
      const result = {};
      for (const [key, field] of Object.entries(schema.properties)) {
        if (!Object.hasOwn(value, key)) {
          if (schema.required.includes(key)) throw new TypeError('Missing result field.');
          continue;
        }
        result[key] = projectSchema(field, value[key]);
      }
      return result;
    }
    default: throw new TypeError('Unsupported schema type.');
  }
}

export function projectOperationReceipt(value) {
  const result = projectSchema(githubReceiptSchema, value);
  if (result.updatedAtSecs < result.startedAtSecs) throw new TypeError('Invalid receipt timestamps.');
  if (result.state === 'succeeded') {
    if (result.errorCode !== null) throw new TypeError('A success cannot contain an error.');
    if (result.action === 'create_repository') {
      if (!result.createdRepository || !result.createdRepository.private || result.commit !== null) {
        throw new TypeError('Creation success requires a private repository receipt.');
      }
    } else if (!result.commit) throw new TypeError('Commit identity is missing.');
    if (['push', 'commit_push'].includes(result.action)) {
      const pushed = result.commit.pushed;
      if (!pushed || !pushed.repository || pushed.pushedHead !== result.commit.afterHead
        || pushed.verifiedRemoteHead !== pushed.pushedHead) {
        throw new TypeError('Publication success requires matching verified remote evidence.');
      }
    }
  }
  if (result.state === 'succeeded' && result.expected && result.commit) {
    const expected = result.expected;
    if ((result.action === 'push' && expected.localHead !== result.commit.afterHead)
      || (result.action !== 'push' && expected.localHead !== result.commit.beforeHead)) {
      throw new TypeError('The receipt does not match the approved source commit.');
    }
    if (expected.publication && result.commit.pushed
      && (expected.publication.repository !== result.commit.pushed.repository
        || expected.publication.branch !== result.commit.pushed.branch)) {
      throw new TypeError('The receipt does not match the approved destination.');
    }
  }
  return result;
}

// The application supplies its real installed Zod namespace. This module does
// not import or replace an SDK, and offline contract tests remain dependency-free.

export function receiptZodSchema(z) {
  function convert(schema) {
    if (Object.hasOwn(schema, 'const')) return z.literal(schema.const);
    if (schema.anyOf) return z.union(schema.anyOf.map(convert));
    if (schema.enum) return z.enum(schema.enum);
    switch (schema.type) {
      case 'null': return z.null();
      case 'boolean': return z.boolean();
      case 'integer': {
        let result = z.number().int();
        if (schema.minimum !== undefined) result = result.min(schema.minimum);
        if (schema.maximum !== undefined) result = result.max(schema.maximum);
        return result;
      }
      case 'string': {
        let result = z.string().max(schema.maxLength);
        return schema.pattern ? result.regex(new RegExp(schema.pattern)) : result;
      }
      case 'array': return z.array(convert(schema.items)).max(schema.maxItems);
      case 'object': return z.object(Object.fromEntries(Object.entries(schema.properties).map(([key, field]) => {
        const result = convert(field);
        return [key, schema.required.includes(key) ? result : result.optional()];
      }))).strict();
      default: throw new TypeError('Unsupported schema type.');
    }
  }
  return convert(githubReceiptSchema);
}
