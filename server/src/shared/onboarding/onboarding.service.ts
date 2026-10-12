// Importing modules
import { brevoEnabled } from "../../providers/brevo.js";
import mongoose from "mongoose";
import Organization from "../models/organization.model.js";
import BusinessProfile from "../models/businessProfile.model.js";
import EmailIntegration from "../models/emailIntegration.model.js";
import Lead, { leadDedupeKey } from "../models/lead.model.js";
import Message from "../models/message.model.js";
import { getSubscription, entitlementsFor } from "../billing/subscription.service.js";
import { startWorkflow } from "../workflows/workflow.service.js";
import { audit } from "../audit/audit.service.js";
import Conflict from "../errors/Conflict.error.js";

type Id = mongoose.Types.ObjectId;

export const STEPS = ["organization", "business", "icp", "voice", "email", "limits", "test_run", "activation"] as const;
export type Step = (typeof STEPS)[number];

/*
    Onboarding progress is derived from the workspace's real configuration (plus two
    explicit confirmations), so leaving halfway and coming back resumes at the first
    unfinished step, and nothing can be marked done without actually being configured.
*/
export async function onboardingStatus(organizationId: Id) {
    const [org, profile, email, { subscription, suspended }] = await Promise.all([
        Organization.findById(organizationId).lean(),
        BusinessProfile.findOne({ organizationId }).lean(),
        EmailIntegration.findOne({ organizationId }).lean(),
        entitlementsFor(organizationId),
    ]);
    const testLead = org?.onboarding?.testLeadId ? await Lead.findOne({ organizationId, _id: org.onboarding.testLeadId }).lean() : null;
    const testMessage = testLead ? await Message.findOne({ organizationId, leadId: testLead._id, direction: "outbound", status: { $nin: ["draft", "rejected", "failed"] } }).lean() : null;
    const icp = profile?.idealCustomerProfile;

    const issues: Record<Step, string[]> = {
        organization: [!org?.industry && "Add your industry", !org?.timezone && "Set your timezone"].filter(Boolean) as string[],
        business: [
            !profile?.description?.trim() && "Describe what you do",
            !profile?.services?.length && "Add at least one service with a price",
        ].filter(Boolean) as string[],
        icp: [!(icp?.industries?.length || icp?.regions?.length || icp?.companySizes?.length || icp?.requiredSignals?.length) && "Describe your ideal customer (industries, regions, sizes or signals)"].filter(Boolean) as string[],
        voice: [!org?.onboarding?.voiceConfirmedAt && "Confirm brand voice and the claims the agents may make"].filter(Boolean) as string[],
        email: [
            // the platform address (Brevo) counts: connecting an own mailbox is optional when it is set
            !email && !brevoEnabled() && "Connect your email account",
            email && email.status !== "connected" && `Email account needs attention: ${email.lastError ?? email.status}`,
        ].filter(Boolean) as string[],
        limits: [
            !org?.onboarding?.limitsConfirmedAt && "Review spending limits and sending rules",
            suspended && "Your subscription is inactive",
        ].filter(Boolean) as string[],
        test_run: [!testMessage && (testLead ? "The test run has not produced its email yet" : "Run the test workflow")].filter(Boolean) as string[],
        activation: [!org?.activatedAt && "Activate to start contacting real prospects"].filter(Boolean) as string[],
    };
    const steps = STEPS.map((s) => ({ step: s, done: issues[s].length === 0, issues: issues[s] }));
    return {
        currentStep: steps.find((s) => !s.done)?.step ?? null,
        steps,
        activatedAt: org?.activatedAt ?? null,
        subscription: { planKey: subscription.planKey, status: subscription.status, currentPeriodEnd: subscription.currentPeriodEnd },
        testRun: testLead ? { leadId: testLead._id, messageStatus: testMessage?.status ?? null } : null,
    };
}

const BEFORE_TEST: Step[] = ["organization", "business", "icp", "voice", "email", "limits"];

/*
    A safe rehearsal: a synthetic lead whose contact is the requesting user, run through the
    real pipeline. The only possible recipient is the user themself.
*/
export async function startTestRun(organizationId: Id, user: { id: string; email: string }) {
    const status = await onboardingStatus(organizationId);
    const missing = status.steps.filter((s) => BEFORE_TEST.includes(s.step) && !s.done);
    if (missing.length) throw new Conflict(`Finish setup first: ${missing.flatMap((s) => s.issues).join("; ")}`);
    const org = await Organization.findById(organizationId).lean();
    let lead = org?.onboarding?.testLeadId ? await Lead.findOne({ organizationId, _id: org.onboarding.testLeadId }) : null;
    if (!lead) {
        const doc = {
            company: { name: "Test run (you)", industry: org?.industry ?? undefined }, contact: { name: "You", email: user.email.toLowerCase() },
            consent: { basis: "opt_in", source: "Workspace user's own address (onboarding test)", recordedAt: new Date() },
            source: { provider: "manual" }, isTest: true,
        };
        lead = await Lead.findOneAndUpdate(
            { organizationId, dedupeKey: `test:${leadDedupeKey(doc)}` },
            { $setOnInsert: { organizationId, ...doc, dedupeKey: `test:${leadDedupeKey(doc)}`, ownerId: user.id } },
            { upsert: true, new: true },
        );
        await Organization.updateOne({ _id: organizationId }, { "onboarding.testLeadId": lead!._id });
    }
    const { workflow } = await startWorkflow({
        organizationId, type: "lead.pipeline", entityType: "lead", entityId: lead!._id, input: { test: true },
        idempotencyKey: `onboarding-test:${lead!._id}:${Date.now()}`, startedBy: user.id, actor: { type: "user", id: user.id },
    });
    await audit({ organizationId, actorType: "user", actorId: user.id, action: "onboarding.test_run", targetType: "lead", targetId: String(lead!._id), outcome: "pending" });
    return { leadId: lead!._id, workflowId: workflow._id };
}

// explicit activation: real prospects can be contacted only after every step passed
export async function activate(organizationId: Id, userId: string) {
    const status = await onboardingStatus(organizationId);
    const missing = status.steps.filter((s) => s.step !== "activation" && !s.done);
    if (missing.length) throw new Conflict(`Not ready to activate: ${missing.flatMap((s) => s.issues).join("; ")}`);
    await Organization.updateOne({ _id: organizationId, activatedAt: null }, { activatedAt: new Date(), activatedBy: userId });
    await getSubscription(organizationId);
    await audit({ organizationId, actorType: "user", actorId: userId, action: "organization.activate", targetType: "organization", targetId: String(organizationId), outcome: "success" });
    return onboardingStatus(organizationId);
}
