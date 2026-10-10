import "./testEnv.js";
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
    const calls: { agent: string; user: string }[] = [];
    const gateway: LlmGateway = {
        async structured({ agent, schema, user }) {
            calls.push({ agent, user });
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

let seq = 0;

// signs up a user (which creates their organization), verifies them and returns an auth header
export async function createAccount(name = "Owner") {
    seq += 1;
    const email = `user${seq}-${Date.now()}@example.com`;
    const password = "correct-horse-battery";
    const signup = await request(app).post("/api/auth/signup").send({ name, email, password, organizationName: `${name} Co ${seq}` });
    if (signup.status !== 201) throw new Error(`signup failed: ${signup.status} ${JSON.stringify(signup.body)}`);
    await User.updateOne({ email }, { isVerified: true });
    const login = await request(app).post("/api/auth/login").send({ email, password });
    const token = login.body.data.accessToken as string;
    const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
    return { email, password, token, auth: { Authorization: `Bearer ${token}` }, organizationId: me.body.data.organizations[0].id as string };
}
