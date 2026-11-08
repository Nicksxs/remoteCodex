import { timingSafeEqual } from "node:crypto";

export function tokenMatches(expected, supplied) {
  if (typeof expected !== "string" || typeof supplied !== "string") return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function bearerToken(request) {
  const value = request.headers.authorization || "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

export function safeJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}
