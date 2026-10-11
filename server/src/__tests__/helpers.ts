import "./testEnv.js";
import { setImapClient } from "../shared/conversations/imap.service.js";
import Organization from "../shared/models/organization.model.js";
import mongoose from "mongoose";
import request from "supertest";
import { MongoMemoryServer } from "mongodb-memory-server";
import createApp from "../app.js";
import User from "../shared/models/user.model.js";
import { setLlm, LlmGateway } from "../agents/llm.js";
import { setEmailProvider, OutboundEmail } from "../providers/email.provider.js";
import { resetCheckpointer } from "../agents/graphs/common.js";

let mongo: MongoMemoryServer | null = null;

export const app = createApp();

export async function startDb() {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), { dbName: "easysales_test" });
    // unique indexes are part of the behaviour under test (dedupe, idempotency)
    await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
}

export async function stopDb() {
    resetCheckpointer();
    await mongoose.disconnect();
    await mongo?.stop();
}

// deterministic stand-in for the model: returns a fixture per agent name
export function fakeLlm(fixtures: Record<string, unknown | ((user: string) => unknown)>) {
    const calls: { agent: string; user: string; system: string }[] = [];
    const gateway: LlmGateway = {
        async structured({ agent, schema, user, system }) {
            calls.push({ agent, user, system });
            const f = fixtures[agent];
            if (f === undefined) throw new Error(`No fixture for agent ${agent}`);
            const data = typeof f === "function" ? (f as (u: string) => unknown)(user) : f;
            return { data: schema.parse(data), model: "fake-model", inputTokens: 100, outputTokens: 50 };
        },
    };
    setLlm(gateway);
    return calls;
}

// captures outbound email instead of sending it
export function fakeMailbox() {
    const sent: OutboundEmail[] = [];
    setEmailProvider({ name: "fake", async send(email) { sent.push(email); return { providerMessageId: `fake-${sent.length}` }; } });
    return sent;
}

// an in-memory IMAP inbox (every test file starts with an empty one, so connecting never touches the network)
export function fakeInbox(state: { uidValidity: number; messages: { uid: number; from: string; inReplyTo?: string; raw: string }[] } = { uidValidity: 1, messages: [] }) {
    const downloaded: number[] = [];
    setImapClient(async () => ({
        async connect() {}, async logout() {},
        async mailboxOpen() { return { uidValidity: state.uidValidity, uidNext: Math.max(0, ...state.messages.map((m) => m.uid)) + 1 }; },
        async search(q: { uid: string }) { const from = Number(q.uid.split(":")[0]); const all = state.messages.map((m) => m.uid); return all.filter((u) => u >= from).concat(all.length ? [Math.max(...all)] : []); },
        async fetchAll(uids: number[]) { return state.messages.filter((m) => uids.includes(m.uid)).map((m) => ({ uid: m.uid, size: m.raw.length, envelope: { from: [{ address: m.from }], inReplyTo: m.inReplyTo } })); },
        async fetchOne(uid: string) { downloaded.push(Number(uid)); const m = state.messages.find((x) => x.uid === Number(uid)); return m ? { source: Buffer.from(m.raw) } : false; },
    }));
    return { state, downloaded };
}
fakeInbox();

let seq = 0;

// signs up a user (which creates their organization), verifies them and returns an auth header
export async function createAccount(name = "Owner", opts: { activated?: boolean } = {}) {
    seq += 1;
    const email = `user${seq}-${Date.now()}@example.com`;
    const password = "correct-horse-battery";
    const signup = await request(app).post("/api/auth/signup").send({ name, email, password, organizationName: `${name} Co ${seq}` });
    if (signup.status !== 201) throw new Error(`signup failed: ${signup.status} ${JSON.stringify(signup.body)}`);
    await User.updateOne({ email }, { isVerified: true });
    const login = await request(app).post("/api/auth/login").send({ email, password });
    const token = login.body.data.accessToken as string;
    const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
    // existing suites exercise a live workspace; onboarding/activation is covered in sprint7.test.ts
    if (opts.activated !== false) await Organization.updateOne({ _id: me.body.data.organizations[0].id }, { activatedAt: new Date() });
    return { email, password, token, auth: { Authorization: `Bearer ${token}` }, organizationId: me.body.data.organizations[0].id as string };
}
