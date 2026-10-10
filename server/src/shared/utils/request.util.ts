// Importing modules
import mongoose from "mongoose";
import NotFound from "../errors/NotFound.error.js";

// parses a route id; malformed ids are treated as "not found" (never a 500, never a hint)
export function oid(value: unknown): mongoose.Types.ObjectId {
    if (typeof value !== "string" || !mongoose.isValidObjectId(value)) throw new NotFound("Resource not found");
    return new mongoose.Types.ObjectId(value);
}

// cursor pagination by _id (newest first)
export function pageParams(query: Record<string, unknown>) {
    const limit = Math.min(Math.max(Number(query.limit) || 25, 1), 100);
    const cursor = typeof query.cursor === "string" && mongoose.isValidObjectId(query.cursor) ? new mongoose.Types.ObjectId(query.cursor) : null;
    return { limit, cursorFilter: cursor ? { _id: { $lt: cursor } } : {} };
}

export function nextCursor<T extends { _id: mongoose.Types.ObjectId }>(items: T[], limit: number) {
    return items.length === limit ? items[items.length - 1]._id.toString() : null;
}

// escapes user text for safe use inside a RegExp
export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const str = (v: unknown) => (typeof v === "string" ? v : undefined);
