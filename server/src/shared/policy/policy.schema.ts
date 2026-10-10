// Importing modules
import z from "zod";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24h)");

// the configurable rules an organization sets for its AI agents
export const PolicyConfigSchema = z.object({
    outreach: z.object({
        enabled: z.boolean(),
        channels: z.array(z.enum(["email"])).min(1),
        // when false, every outbound message waits for a human approval
        autoSend: z.boolean(),
        requireConsentBasis: z.boolean(),
        maxNewContactsPerDay: z.number().int().min(0).max(1000),
        maxFollowUps: z.number().int().min(0).max(10),
        minimumFollowUpIntervalHours: z.number().int().min(1).max(24 * 30),
        quietHours: z.object({
            enabled: z.boolean(),
            start: hhmm,
            end: hhmm,
            timezone: z.string().min(1),
        }),
    }),
    qualification: z.object({
        minimumScore: z.number().int().min(0).max(100),
    }),
    pricing: z.object({
        currency: z.string().length(3),
        minimumDealValueMinor: z.number().int().min(0),
        maximumDiscountPercent: z.number().min(0).max(100),
    }),
    proposals: z.object({
        autoSend: z.boolean(),
    }),
    budgets: z.object({
        maxLlmCallsPerDay: z.number().int().min(0).max(100000),
    }),
}).strict();

export type PolicyConfig = z.infer<typeof PolicyConfigSchema>;

// conservative defaults for a brand new organization: nothing leaves the building without a human
export const DEFAULT_POLICY: PolicyConfig = {
    outreach: {
        enabled: true,
        channels: ["email"],
        autoSend: false,
        requireConsentBasis: true,
        maxNewContactsPerDay: 20,
        maxFollowUps: 2,
        minimumFollowUpIntervalHours: 72,
        quietHours: { enabled: true, start: "19:00", end: "09:00", timezone: "Asia/Kolkata" },
    },
    qualification: { minimumScore: 60 },
    pricing: { currency: "INR", minimumDealValueMinor: 25000_00, maximumDiscountPercent: 10 },
    proposals: { autoSend: false },
    budgets: { maxLlmCallsPerDay: 500 },
};
