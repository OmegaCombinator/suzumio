import { randomUUID } from "node:crypto";

export function createId(prefix: string): string {
  return `${prefix}_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_");
}
