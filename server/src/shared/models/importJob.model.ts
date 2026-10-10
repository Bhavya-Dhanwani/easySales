// Importing modules
import mongoose from "mongoose";
import tenantPlugin, { tenantFields } from "../tenancy/tenant.plugin.js";

// one CSV import: counts plus row-level errors for the downloadable error report
const importJobSchema = new mongoose.Schema({

    ...tenantFields,

    status: { type: String, enum: ["queued", "processing", "completed", "completed_with_errors", "failed"], default: "processing" },

    fileName: { type: String, maxlength: 200 },

    // a retried upload with the same key returns this job instead of importing twice
    idempotencyKey: { type: String, required: true },

    totalRows: { type: Number, default: 0 },
    createdRows: { type: Number, default: 0 },
    duplicateRows: { type: Number, default: 0 },
    invalidRows: { type: Number, default: 0 },

    rowErrors: [{
        _id: false,
        row: Number,
        kind: { type: String, enum: ["invalid", "duplicate"] },
        message: String,
        company: String,
        email: String,
    }],

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    startedAt: { type: Date, default: Date.now },

    completedAt: Date,

}, { timestamps: true });

importJobSchema.plugin(tenantPlugin);
importJobSchema.index({ organizationId: 1, idempotencyKey: 1 }, { unique: true });
importJobSchema.index({ organizationId: 1, createdAt: -1 });

const ImportJob = mongoose.model("ImportJob", importJobSchema);

export default ImportJob;
