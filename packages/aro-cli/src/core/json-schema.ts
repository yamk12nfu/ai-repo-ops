/**
 * JSON Schema（draft-07 の使用サブセットのみ）を解釈する最小バリデータ。
 *
 * 計画 v3 §0.1.5「`aro doctor` の検証は ai-repo-ops source 側の authoritative schema を使う」に
 * 対応する。`schemas/project.schema.json` は zod ではなく JSON Schema（draft-07）で書かれているため、
 * doctor はこの schema ファイルを直接解釈して検証する必要がある。
 *
 * MVP では専用ライブラリ（ajv 等）を追加せず、`schemas/project.schema.json` が実際に使うキーワード
 * （type / enum / const / required / properties / additionalProperties / items / minLength / minimum）
 * だけを解釈する薄い実装にする（§7「標準APIで十分な箇所は標準API優先」の精神を JSON Schema 解釈にも適用）。
 * schema はデータであり、ここにコピー・二重管理はしない（authoritative schema をそのまま渡して使う）。
 */

/** 1 件の検証違反。`path` は `$` を root とした dot/bracket 記法。 */
export interface JsonSchemaIssue {
  /** 違反箇所（例: `$.project.risk_level`）。 */
  path: string;
  /** 人間向けメッセージ。 */
  message: string;
}

/** サポートする JSON Schema ノード（このモジュールが解釈するキーワードのみ）。 */
interface JsonSchemaNode {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  required?: string[];
  properties?: Record<string, unknown>;
  additionalProperties?: unknown;
  items?: unknown;
  minLength?: number;
  minimum?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON.stringify ベースの簡易等価比較。const / enum は string/number/boolean/null 中心のため十分。 */
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** schema の `type` 1 件が value に一致するか。未知の type 名は forward-compatible に許容する。 */
function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

/**
 * value を schema ノードに対して再帰検証し、違反を issues に積む。
 * schema が object でない（壊れた schema）場合は何もしない（authoritative schema は zod 相当の
 * 事前検証をしていないため、防御的に無視する。schema 自体の妥当性は呼び出し側の責務外）。
 */
function validateNode(schemaRaw: unknown, value: unknown, path: string, issues: JsonSchemaIssue[]): void {
  if (!isRecord(schemaRaw)) {
    return;
  }
  const schema = schemaRaw as JsonSchemaNode;

  if (schema.const !== undefined) {
    if (!deepEqual(value, schema.const)) {
      issues.push({ path, message: `must be ${JSON.stringify(schema.const)}` });
      return;
    }
  }

  if (schema.enum !== undefined) {
    if (!schema.enum.some((option) => deepEqual(option, value))) {
      issues.push({ path, message: `must be one of ${JSON.stringify(schema.enum)}` });
    }
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(t, value))) {
      issues.push({ path, message: `must be of type ${types.join(" | ")}` });
      return;
    }
  }

  if (typeof value === "string" && typeof schema.minLength === "number" && value.length < schema.minLength) {
    issues.push({ path, message: `must have length >= ${schema.minLength}` });
  }

  if (typeof value === "number" && typeof schema.minimum === "number" && value < schema.minimum) {
    issues.push({ path, message: `must be >= ${schema.minimum}` });
  }

  if (Array.isArray(schema.required) && isRecord(value)) {
    for (const key of schema.required) {
      if (!Object.hasOwn(value, key)) {
        issues.push({ path: `${path}.${key}`, message: "is required" });
      }
    }
  }

  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const [key, subSchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) {
        validateNode(subSchema, value[key], `${path}.${key}`, issues);
      }
    }
    if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
      for (const key of Object.keys(value)) {
        if (Object.hasOwn(properties, key)) continue;
        if (schema.additionalProperties === false) {
          issues.push({ path: `${path}.${key}`, message: "additional property is not allowed" });
        } else {
          validateNode(schema.additionalProperties, value[key], `${path}.${key}`, issues);
        }
      }
    }
  }

  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, index) => {
      validateNode(schema.items, item, `${path}[${index}]`, issues);
    });
  }
}

/**
 * value を JSON Schema（このモジュールがサポートするキーワードのみ）に対して検証する。
 * @param schema `schemas/project.schema.json` を JSON.parse した値。
 * @param value  検証対象（YAML parse 結果など）。
 * @returns 違反の配列。空配列なら valid。
 */
export function validateJsonSchema(schema: unknown, value: unknown): JsonSchemaIssue[] {
  const issues: JsonSchemaIssue[] = [];
  validateNode(schema, value, "$", issues);
  return issues;
}
