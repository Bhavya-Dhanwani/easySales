// Importing modules
import mongoose from "mongoose";
import tenantPlugin, { tenantFields } from "../tenancy/tenant.plugin.js";

export const OAUTH_PROVIDERS = ["hubspot", "google_calendar"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

/*
    A tenant's OAuth connection to an external system. Bound to exactly one organization;
    the external account (HubSpot portal, Google account) can belong to one tenant only, so
    webhooks resolve to their owner from server-side records, never from the payload.
*/
const connectionSchema = new mongoose.Schema({

    ...tenantFields,

    provider: { type: String, enum: OAUTH_PROVIDERS, required: true },

    status: { type: String, enum: ["connected", "degraded", "disconnected"], default: "connected" },

    // HubSpot portal id / Google account email
    externalAccountId: { type: String, required: true },

    accountLabel: String,

    scopes: [String],

    // encrypted with ENCRYPTION_KEY; never returned by the API or given to a model
    accessTokenEnc: { type: String, select: false },
    refreshTokenEnc: { type: String, select: false },
    accessTokenExpiresAt: Date,

    // resumable sync checkpoints, per object type (provider "last modified" in ms)
    cursors: { type: Map, of: Number, default: {} },

    lastSyncAt: Date,
    lastHealthCheckAt: Date,
    lastError: String,

    // CRM: who owns the pipeline stage; calendar: working hours and meeting length
    settings: {
        stageOwner: { type: String, enum: ["platform", "crm"], default: "platform" },
        timezone: String,
        workStart: { type: String, default: "10:00" },
        workEnd: { type: String, default: "18:00" },
        workDays: { type: [Number], default: [1, 2, 3, 4, 5] },
        meetingMinutes: { type: Number, default: 30 },
        bufferMinutes: { type: Number, default: 15 },
        minNoticeHours: { type: Number, default: 12 },
    },

    connectedBy: String,

}, { timestamps: true });

connectionSchema.plugin(tenantPlugin);
connectionSchema.index({ organizationId: 1, provider: 1 }, { unique: true });
// one external account → one tenant (a second tenant cannot hijack another's portal events)
connectionSchema.index({ provider: 1, externalAccountId: 1 }, { unique: true, partialFilterExpression: { status: { $in: ["connected", "degraded"] } } });

export const IntegrationConnection = mongoose.model("IntegrationConnection", connectionSchema);

/*
    Internal record ↔ external record. Unique both ways, so a re-import or a retried push can
    never create a second mapping (and therefore never a duplicate record on either side).
*/
const externalRecordSchema = new mongoose.Schema({

    ...tenantFields,

    connectionId: { type: mongoose.Schema.Types.ObjectId, ref: "IntegrationConnection", required: true },

    provider: { type: String, required: true },

    entityType: { type: String, enum: ["contact", "company", "deal"], required: true },

    // our lead (contacts, deals); companies have no internal record of their own
    internalRecordId: { type: mongoose.Schema.Types.ObjectId, default: null },

    externalRecordId: { type: String, required: true },

    // CRM-owned company fields, so later company changes can be fanned out to its leads
    snapshot: { type: mongoose.Schema.Types.Mixed, default: {} },

    // newest provider modification applied: older (out-of-order) updates are ignored
    lastExternalUpdatedAt: Date,

    lastSyncedAt: Date,

    lastSyncStatus: { type: String, enum: ["success", "pending", "failed", "deleted_externally"], default: "success" },

    lastError: String,

}, { timestamps: true });

externalRecordSchema.plugin(tenantPlugin);
externalRecordSchema.index({ organizationId: 1, connectionId: 1, entityType: 1, externalRecordId: 1 }, { unique: true });
externalRecordSchema.index({ organizationId: 1, connectionId: 1, entityType: 1, internalRecordId: 1 }, { unique: true, partialFilterExpression: { internalRecordId: { $type: "objectId" } } });

export const ExternalRecord = mongoose.model("ExternalRecord", externalRecordSchema);

// single-use OAuth state (CSRF) with the PKCE verifier; expires after 10 minutes
const oauthStateSchema = new mongoose.Schema({
    state: { type: String, required: true, unique: true },
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true },
    userId: { type: String, required: true },
    provider: { type: String, enum: OAUTH_PROVIDERS, required: true },
    codeVerifier: String,
    expiresAt: { type: Date, required: true },
});
oauthStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const OAuthState = mongoose.model("OAuthState", oauthStateSchema);

// provider webhook events, stored (deduplicated) before acknowledging, processed by the worker
const integrationEventSchema = new mongoose.Schema({

    ...tenantFields,

    connectionId: { type: mongoose.Schema.Types.ObjectId, ref: "IntegrationConnection", required: true },

    provider: { type: String, required: true },

    eventId: { type: String, required: true },

    type: { type: String, required: true },

    objectId: String,

    payload: { type: mongoose.Schema.Types.Mixed },

    occurredAt: Date,

    status: { type: String, enum: ["pending", "processing", "processed", "ignored", "failed"], default: "pending" },

    attempts: { type: Number, default: 0 },

    lockedUntil: Date,

    error: String,

}, { timestamps: true });

integrationEventSchema.plugin(tenantPlugin);
integrationEventSchema.index({ provider: 1, connectionId: 1, eventId: 1 }, { unique: true });
integrationEventSchema.index({ status: 1, createdAt: 1 });

export const IntegrationEvent = mongoose.model("IntegrationEvent", integrationEventSchema);

/*
    A meeting booked on the business's calendar. Times are UTC; the timezone is kept for
    display. The partial unique index on (org, start) for live meetings means two
    concurrent bookings of one slot cannot both succeed.
*/
const meetingSchema = new mongoose.Schema({

    ...tenantFields,

    leadId: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", required: true },

    connectionId: { type: mongoose.Schema.Types.ObjectId, ref: "IntegrationConnection", required: true },

    start: { type: Date, required: true },

    end: { type: Date, required: true },

    timezone: { type: String, required: true },

    status: { type: String, enum: ["booking", "booked", "rescheduled", "cancelled", "failed"], default: "booking" },

    // deterministic provider event id: a retried create returns the same event, never a second one
    externalEventId: { type: String, required: true },

    inviteProspect: { type: Boolean, default: false },

    attendees: [String],

    title: String,

    meetLink: String,

    bookedBy: String,

    cancelledReason: String,

}, { timestamps: true });

meetingSchema.plugin(tenantPlugin);
meetingSchema.index({ organizationId: 1, start: 1 }, { unique: true, partialFilterExpression: { status: { $in: ["booking", "booked", "rescheduled"] } } });
meetingSchema.index({ organizationId: 1, leadId: 1, start: -1 });
meetingSchema.index({ externalEventId: 1 }, { unique: true });

export const Meeting = mongoose.model("Meeting", meetingSchema);
