/**
 * Version of the telemetry schema, independent of package versions.
 * Bump per semver when event shapes change: a major bump means existing
 * uploads/parsers are incompatible. Collectors stamp this into every payload
 * so the server can validate against the exact schema the CLI used.
 */
export const SCHEMA_VERSION = "1.6.0";
