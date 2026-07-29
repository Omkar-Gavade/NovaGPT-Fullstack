/**
 * Structured logging, as a dependency.
 *
 * Every method takes an `event` name and a fields object — never a formatted
 * sentence. The event name is a stable contract that dashboards and alerts
 * depend on; message copy is not
 * (docs/backend/11-observability.md#structured-json-always).
 *
 * @typedef {object} LoggerPort
 * @property {(event: string, fields?: object) => void} debug
 * @property {(event: string, fields?: object) => void} info
 * @property {(event: string, fields?: object) => void} warn
 * @property {(event: string, fields?: object) => void} error
 * @property {(bindings: object) => LoggerPort} child  logger with fields pre-bound
 */

export {};
