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
        maxPerHour: z.number().int().min(1).max(500).default(10),
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
        minimumEvidenceCoverage: z.number().int().min(0).max(100).default(60),
        reviewScore: z.number().int().min(0).max(100).default(50),
    }),
    pricing: z.object({
        currency: z.string().length(3),
        minimumDealValueMinor: z.number().int().min(0),
        maximumDiscountPercent: z.number().min(0).max(100),
        // deals above this need a human (enterprise quoting stays manual)
        maximumDealValueMinor: z.number().int().min(0).default(10_00_000_00),
        // tax on the discounted subtotal, in basis points (1800 = 18%); 0 when prices are tax-inclusive
        taxBasisPoints: z.number().int().min(0).max(10000).default(0),
        proposalValidityDays: z.number().int().min(1).max(180).default(30),
    }),
    proposals: z.object({
        autoSend: z.boolean(),
    }),
    budgets: z.object({
        maxLlmCallsPerDay: z.number().int().min(0).max(100000),
        // total monthly spend (AI, research, email, prototypes) in the platform billing currency
        monthlySpendMinor: z.number().int().min(0).max(1e11).default(10_000_00),
        maxResearchPerDay: z.number().int().min(0).max(100000).default(200),
        maxConcurrentResearch: z.number().int().min(1).max(50).default(3),
        maxConcurrentBuilds: z.number().int().min(1).max(10).default(1),
        artifactStorageBytes: z.number().int().min(0).max(1e10).default(20_000_000),
    }),
    // demo builds: every attempt is charged against these budgets (same currency as pricing)
    prototypes: z.object({
        enabled: z.boolean(),
        // inside budget a qualified opportunity builds without asking; otherwise a human approves
        autoBuild: z.boolean(),
        costPerAttemptMinor: z.number().int().min(0).max(1e9),
        maxAttempts: z.number().int().min(1).max(3),
        maxPerPrototypeMinor: z.number().int().min(0).max(1e10),
        monthlyBudgetMinor: z.number().int().min(0).max(1e11),
        previewDays: z.number().int().min(1).max(30),
    }).default({ enabled: true, autoBuild: true, costPerAttemptMinor: 50_00, maxAttempts: 2, maxPerPrototypeMinor: 200_00, monthlyBudgetMinor: 5000_00, previewDays: 7 }),
    // data retention (days); enforced daily by the worker
    retention: z.object({
        messageDays: z.number().int().min(30).max(3650),
        auditDays: z.number().int().min(90).max(3650),
    }).default({ messageDays: 365, auditDays: 730 }),
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
        maxPerHour: 10,
        maxFollowUps: 2,
        minimumFollowUpIntervalHours: 72,
        quietHours: { enabled: true, start: "19:00", end: "09:00", timezone: "Asia/Kolkata" },
    },
    qualification: { minimumScore: 70, minimumEvidenceCoverage: 60, reviewScore: 50 },
    pricing: { currency: "INR", minimumDealValueMinor: 25000_00, maximumDiscountPercent: 10, maximumDealValueMinor: 10_00_000_00, taxBasisPoints: 0, proposalValidityDays: 30 },
    proposals: { autoSend: false },
    budgets: { maxLlmCallsPerDay: 500, monthlySpendMinor: 10_000_00, maxResearchPerDay: 200, maxConcurrentResearch: 3, maxConcurrentBuilds: 1, artifactStorageBytes: 20_000_000 },
    prototypes: { enabled: true, autoBuild: true, costPerAttemptMinor: 50_00, maxAttempts: 2, maxPerPrototypeMinor: 200_00, monthlyBudgetMinor: 5000_00, previewDays: 7 },
    retention: { messageDays: 365, auditDays: 730 },
};
