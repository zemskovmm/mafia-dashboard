import type { TableEntity, TableEntityResult } from "@azure/data-tables";

export type BackupProperty = {
  type: "String" | "Boolean" | "Int32" | "Int64" | "Double" | "DateTime" | "Binary" | "Guid";
  value: string;
};
export interface BackupRow {
  partitionKey: string;
  rowKey: string;
  properties: Record<string, BackupProperty>;
  service: { etag: string; timestamp: string };
}
const metadata = new Set(["partitionKey", "rowKey", "etag", "timestamp", "odata.metadata"]);
const fail = (): never => {
  throw new Error("Unsupported or malformed typed backup row");
};
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const tableKey = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !value.length ||
    Buffer.byteLength(value, "utf16le") > 1024 ||
    [...value].some(
      (character) =>
        "/\\#?".includes(character) ||
        character.charCodeAt(0) < 32 ||
        (character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159),
    )
  )
    return fail();
  return value;
};
export const binary = (value: string): Buffer => {
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) return fail();
  return bytes;
};
const checkedProperty = (input: unknown): BackupProperty => {
  if (
    !object(input) ||
    Object.keys(input).sort().join(",") !== "type,value" ||
    typeof input.type !== "string" ||
    typeof input.value !== "string"
  )
    return fail();
  const { type, value } = input;
  switch (type) {
    case "String":
      if (Buffer.byteLength(value, "utf16le") > 65536) return fail();
      break;
    case "Binary":
      if (binary(value).length > 65536) return fail();
      break;
    case "Boolean":
      if (value !== "true" && value !== "false") return fail();
      break;
    case "Int32":
      if (
        !/^-?(0|[1-9]\d*)$/.test(value) ||
        BigInt(value) < -2147483648n ||
        BigInt(value) > 2147483647n
      )
        return fail();
      break;
    case "Int64":
      if (
        !/^-?(0|[1-9]\d*)$/.test(value) ||
        value.length > 20 ||
        BigInt(value) < -9223372036854775808n ||
        BigInt(value) > 9223372036854775807n
      )
        return fail();
      break;
    case "Double":
      if (!value.length || !Number.isFinite(Number(value)) || String(Number(value)) !== value)
        return fail();
      break;
    case "DateTime": {
      const parts = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,7}))?Z$/.exec(value);
      const milliseconds =
        parts === null ? "" : `${parts[1]}.${(parts[2] ?? "").padEnd(3, "0").slice(0, 3)}Z`;
      if (
        parts === null ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).getUTCFullYear() < 1601 ||
        new Date(value).toISOString() !== milliseconds
      )
        return fail();
      break;
    }
    case "Guid":
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
        return fail();
      break;
    default:
      return fail();
  }
  return { type, value } as BackupProperty;
};
export const validateBackupRow = (input: unknown): BackupRow => {
  if (
    !object(input) ||
    Object.keys(input).sort().join(",") !== "partitionKey,properties,rowKey,service" ||
    !object(input.properties) ||
    !object(input.service) ||
    Object.keys(input.service).sort().join(",") !== "etag,timestamp" ||
    typeof input.service.etag !== "string" ||
    typeof input.service.timestamp !== "string" ||
    !Number.isFinite(Date.parse(input.service.timestamp))
  )
    return fail();
  const properties: Record<string, BackupProperty> = Object.create(null) as Record<
    string,
    BackupProperty
  >;
  const entries = Object.entries(input.properties).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length > 252) return fail();
  let size = 128;
  for (const [name, item] of entries) {
    if (
      metadata.has(name) ||
      !/^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(name) ||
      name === "__proto__" ||
      name === "constructor" ||
      name === "prototype"
    )
      return fail();
    const property = checkedProperty(item);
    properties[name] = property;
    size +=
      Buffer.byteLength(name, "utf16le") +
      32 +
      (property.type === "String"
        ? Buffer.byteLength(property.value, "utf16le")
        : property.type === "Binary"
          ? binary(property.value).length
          : 8);
  }
  if (size > 1048576) return fail();
  return {
    partitionKey: tableKey(input.partitionKey),
    rowKey: tableKey(input.rowKey),
    properties,
    service: { etag: input.service.etag, timestamp: input.service.timestamp },
  };
};
/** SDK disableTypeConversion keeps Int64 strings exact; never infer from a double. */
export const encodeBackupRow = (entity: TableEntityResult<Record<string, unknown>>): BackupRow => {
  const properties: Record<string, BackupProperty> = Object.create(null) as Record<
    string,
    BackupProperty
  >;
  for (const [name, item] of Object.entries(entity)) {
    if (metadata.has(name)) continue;
    if (
      !object(item) ||
      typeof item.type !== "string" ||
      !["string", "number", "boolean"].includes(typeof item.value)
    )
      return fail();
    const value = String(item.value);
    // The SDK infers every integral JSON number as Int32, including values outside
    // that type's range. The service represents those as Double, not Int64.
    const type =
      item.type === "Int32" &&
      typeof item.value === "string" &&
      /^-?\d+$/.test(item.value) &&
      (BigInt(item.value) < -2147483648n || BigInt(item.value) > 2147483647n)
        ? "Double"
        : item.type;
    properties[name] = checkedProperty({ type, value });
  }
  return validateBackupRow({
    partitionKey: entity.partitionKey,
    rowKey: entity.rowKey,
    properties,
    service: { etag: entity.etag, timestamp: entity.timestamp },
  });
};
export const decodeBackupRow = (row: BackupRow): TableEntity => {
  const entity: TableEntity = { partitionKey: row.partitionKey, rowKey: row.rowKey };
  for (const [name, { type, value }] of Object.entries(row.properties)) {
    entity[name] = {
      type,
      value:
        type === "Boolean"
          ? value === "true"
          : type === "Int32" || type === "Double"
            ? Number(value)
            : value,
    };
  }
  return entity;
};
/** Application-level values, only for validating control and reference roots. */
export const backupRowValues = (row: BackupRow): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(row.properties).map(([name, { type, value }]) => [
      name,
      type === "Boolean"
        ? value === "true"
        : type === "Int32" || type === "Double"
          ? Number(value)
          : type === "Binary"
            ? binary(value)
            : type === "Int64"
              ? BigInt(value)
              : value,
    ]),
  );
