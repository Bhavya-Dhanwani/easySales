import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, createAccount, startDb, stopDb } from "./helpers.js";
import Lead from "../shared/models/lead.model.js";
import AuditEvent from "../shared/models/auditEvent.model.js";
import Approval from "../shared/models/approval.model.js";
import Membership from "../shared/models/membership.model.js";
import User from "../shared/models/user.model.js";

before(startDb);
after(stopDb);

test("health check works", async () => {
    const res = await request(app).get("/api/health");
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, "UP");
});

test("auth: no enumeration, no verification bypass, private API needs verification", async () => {
    const unknown = await request(app).post("/api/auth/login").send({ email: "nobody@example.com", password: "whatever-123" });
    const owner = await createAccount("Alice");
    const wrong = await request(app).post("/api/auth/login").send({ email: owner.email, password: "wrong-password" });
    assert.equal(unknown.status, 401);
    assert.equal(wrong.status, 401);
    assert.equal(unknown.body.message, wrong.body.message);

    // the old scaffold let a client mark itself verified by sending any `token`
    const signup = await request(app).post("/api/auth/signup").send({ name: "Mallory", email: "mallory@example.com", password: "password-123", token: "x" });
    assert.equal(signup.status, 201);
    assert.equal(signup.body.data.user.isVerified, false);
    const blocked = await request(app).get("/api/v1/leads").set("Authorization", `Bearer ${signup.body.data.accessToken}`);
    assert.equal(blocked.status, 403);
});

test("tenant isolation: one organization can never see or touch another's data", async () => {
    const a = await createAccount("Alpha");
    const b = await createAccount("Beta");

    const leadB = await request(app).post("/api/v1/leads").set(b.auth).send({ companyName: "Beta Client", contactEmail: "c@beta-client.com" });
    assert.equal(leadB.status, 201);
    const id = leadB.body.data.lead._id;

    // reads, writes, deletes and workflow starts by A against B's lead all look like "not found"
    assert.equal((await request(app).get(`/api/v1/leads/${id}`).set(a.auth)).status, 404);
    assert.equal((await request(app).patch(`/api/v1/leads/${id}`).set(a.auth).send({ opportunityStage: "won" })).status, 404);
    assert.equal((await request(app).delete(`/api/v1/leads/${id}`).set(a.auth)).status, 404);
    assert.equal((await request(app).post(`/api/v1/leads/${id}/run`).set(a.auth)).status, 404);
    const listA = await request(app).get("/api/v1/leads").set(a.auth);
    assert.equal(listA.body.data.leads.length, 0);

    // A cannot switch into B's organization by sending its id
    const hop = await request(app).get("/api/v1/leads").set(a.auth).set("X-Organization-Id", b.organizationId);
    assert.equal(hop.status, 403);

    // A cannot decide B's approvals
    const approval = await Approval.create({
        organizationId: b.organizationId, actionType: "outreach.send", targetType: "message", targetId: id,
        payload: {}, payloadHash: "0".repeat(64), policyVersion: 1, expiresAt: new Date(Date.now() + 3600_000),
    });
    const decide = await request(app).post(`/api/v1/approvals/${approval._id}/approve`).set(a.auth).send({ payloadHash: "0".repeat(64) });
    assert.equal(decide.status, 404);

    // B still owns its untouched lead
    const own = await request(app).get(`/api/v1/leads/${id}`).set(b.auth);
    assert.equal(own.status, 200);
    assert.equal(own.body.data.lead.opportunityStage, "new");
});

test("RBAC: a viewer can read but not write", async () => {
    const owner = await createAccount("Owner");
    const viewer = await createAccount("Viewer");
    const invite = await request(app).post("/api/v1/organization/members").set(owner.auth).send({ email: viewer.email, role: "viewer" });
    assert.equal(invite.status, 201);
    const asViewer = { ...viewer.auth, "X-Organization-Id": owner.organizationId };

    assert.equal((await request(app).get("/api/v1/leads").set(asViewer)).status, 200);
    assert.equal((await request(app).post("/api/v1/leads").set(asViewer).send({ companyName: "X" })).status, 403);
    assert.equal((await request(app).put("/api/v1/policies").set(asViewer).send({})).status, 403);
    assert.equal((await request(app).get("/api/v1/organization/members").set(asViewer)).status, 403);
});

test("invitations only attach to verified accounts", async () => {
    const owner = await createAccount("Inviter");
    await request(app).post("/api/v1/organization/members").set(owner.auth).send({ email: "future@example.com", role: "sales_rep" });
    const signup = await request(app).post("/api/auth/signup").send({ name: "Future", email: "future@example.com", password: "password-123" });
    assert.equal(signup.status, 201);
    const pending = await Membership.findOne({ organizationId: owner.organizationId, email: "future@example.com" });
    assert.equal(pending?.status, "invited");
    assert.equal(pending?.userId, null);
    const user = await User.findOne({ email: "future@example.com" });
    assert.ok(user);
});

test("guards: unscoped tenant queries throw and audit events are append-only", async () => {
    await assert.rejects(() => Lead.find({}).exec(), /organizationId filter is required/);
    await assert.rejects(() => Lead.countDocuments({ "company.name": "x" }).exec(), /organizationId filter is required/);
    const owner = await createAccount("Auditor");
    await assert.rejects(() => AuditEvent.updateMany({ organizationId: owner.organizationId }, { outcome: "success" }).exec(), /append-only/);
    await assert.rejects(() => AuditEvent.deleteMany({ organizationId: owner.organizationId }).exec(), /append-only/);
});

test("lead import deduplicates within the file and against existing leads", async () => {
    const owner = await createAccount("Importer");
    const leads = [
        { companyName: "One", contactEmail: "a@one.com", website: "one.com" },
        { companyName: "One again", contactEmail: "A@ONE.com" },
        { companyName: "Two", website: "https://www.two.io" },
        { companyName: "Two dup", website: "two.io" },
        { companyName: "", contactEmail: "bad" },
    ];
    const first = await request(app).post("/api/v1/leads/import").set(owner.auth).send({ leads });
    assert.equal(first.status, 201);
    assert.equal(first.body.data.created, 2);
    assert.equal(first.body.data.duplicates.length, 2);
    assert.equal(first.body.data.invalid.length, 1);
    const second = await request(app).post("/api/v1/leads/import").set(owner.auth).send({ leads: leads.slice(0, 1) });
    assert.equal(second.body.data.created, 0);
});
