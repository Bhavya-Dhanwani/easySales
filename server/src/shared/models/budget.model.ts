// Importing modules
import mongoose from "mongoose";
import tenantPlugin, { tenantFields } from "../tenancy/tenant.plugin.js";

/*
    One spend counter per tenant, period and bucket. Reservations and settlements are
    single-document conditional $inc updates, so two workers can never both pass a limit.
*/
const spendCounterSchema = new mongoose.Schema({

    ...tenantFields,

    // "2026-10" (monthly buckets) or "2026-10-11" (the global daily cap)
    period: { type: String, required: true },

    bucket: { type: String, enum: ["total", "prototype", "global"], required: true },

    committedMinor: { type: Number, default: 0 },

    reservedMinor: { type: Number, default: 0 },

}, { timestamps: true });

spendCounterSchema.plugin(tenantPlugin);
spendCounterSchema.index({ organizationId: 1, period: 1, bucket: 1 }, { unique: true });

export const SpendCounter = mongoose.model("SpendCounter", spendCounterSchema);

// money held for work that has started but not finished; settled with the actual cost or released
const budgetReservationSchema = new mongoose.Schema({

    ...tenantFields,

    resource: { type: String, required: true },

    refId: String,

    amountMinor: { type: Number, required: true, min: 0 },

    actualMinor: Number,

    status: { type: String, enum: ["reserved", "settled", "released"], default: "reserved" },

    // the counters this reservation was taken from (so settle/release touch exactly those)
    counters: [{ _id: false, organizationId: mongoose.Schema.Types.ObjectId, period: String, bucket: String }],

    // abandoned reservations (crashed worker) are released by housekeeping
    expiresAt: { type: Date, required: true },

}, { timestamps: true });

budgetReservationSchema.plugin(tenantPlugin);
budgetReservationSchema.index({ status: 1, expiresAt: 1 });

export const BudgetReservation = mongoose.model("BudgetReservation", budgetReservationSchema);
