// Importing modules
import { emitSalesEvent } from "../sales/sales.service.js";
import { createHash } from "node:crypto";
import mongoose from "mongoose";
import { IntegrationConnection, Meeting } from "../models/integration.model.js";
import Lead from "../models/lead.model.js";
import Organization from "../models/organization.model.js";
import { audit } from "../audit/audit.service.js";
import { proposeOutbound } from "../outbound/outbound.service.js";
import { ensureConversation } from "../../agents/graphs/common.js";
import logger from "../config/logger.config.js";
import { googleCalendar } from "./providers.js";
import { withProvider } from "./connection.service.js";
import BadRequest from "../errors/BadRequest.error.js";
import Conflict from "../errors/Conflict.error.js";
import NotFound from "../errors/NotFound.error.js";

type Id = mongoose.Types.ObjectId | string;
const ACTIVE = ["booking", "booked", "rescheduled"];

/* ------------------------------ time zones ------------------------------ */

// offset of `tz` at instant `utcMs` (handles DST), from the platform's own tz database
function offsetMs(utcMs: number, tz: string) {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(utcMs));
    const g = (t: string) => Number(p.find((x) => x.type === t)!.value);
    return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - Math.floor(utcMs / 1000) * 1000;
}

// local wall-clock time in `tz` → UTC instant
export function zonedToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string) {
    const guess = Date.UTC(y, m - 1, d, hh, mm);
    let t = guess - offsetMs(guess, tz);
    t = guess - offsetMs(t, tz);
    return new Date(t);
}

const label = (start: Date, end: Date, tz: string) => {
    const day = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(start);
    const time = (d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
    return `${day}, ${time(start)}–${time(end)} (${tz})`;
};

/* ------------------------------ availability ------------------------------ */

async function settingsFor(organizationId: Id) {
    const conn = await IntegrationConnection.findOne({ organizationId, provider: "google_calendar", status: "connected" }).lean();
    if (!conn) throw new NotFound("Google Calendar is not connected");
    const org = await Organization.findById(organizationId, { timezone: 1 }).lean();
    const s: { timezone?: string | null; workStart?: string | null; workEnd?: string | null; workDays?: number[]; meetingMinutes?: number | null; bufferMinutes?: number | null; minNoticeHours?: number | null } = conn.settings ?? {};
    return {
        tz: s.timezone || org?.timezone || "UTC", workStart: s.workStart ?? "10:00", workEnd: s.workEnd ?? "18:00", workDays: s.workDays?.length ? s.workDays : [1, 2, 3, 4, 5],
        minutes: s.meetingMinutes ?? 30, buffer: s.bufferMinutes ?? 15, notice: s.minNoticeHours ?? 12,
    };
}

/*
    Bookable slots from working hours minus real busy time (the provider's free/busy plus
    meetings we already hold). The agent only ever offers slots from this list: it never
    invents availability.
*/
export async function availability(organizationId: Id, opts: { from?: Date; days?: number } = {}) {
    const s = await settingsFor(organizationId);
    const days = Math.min(Math.max(opts.days ?? 7, 1), 21);
    const now = new Date();
    const from = opts.from && opts.from > now ? opts.from : now;
    const to = new Date(from.getTime() + days * 86400_000);
    const [busy, held] = await Promise.all([
        withProvider(organizationId, "google_calendar", (token) => googleCalendar.freeBusy(token, from, to, s.tz)),
        Meeting.find({ organizationId, status: { $in: ACTIVE }, start: { $lt: to }, end: { $gt: from } }, { start: 1, end: 1 }).lean(),
    ]);
    const blocked = [...busy, ...held.map((m) => ({ start: m.start, end: m.end }))];
    const [sh, sm] = s.workStart.split(":").map(Number);
    const [eh, em] = s.workEnd.split(":").map(Number);
    const step = (s.minutes + s.buffer) * 60_000;
    const earliest = now.getTime() + s.notice * 3600_000;
    const localToday = new Intl.DateTimeFormat("en-CA", { timeZone: s.tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(from).split("-").map(Number);
    const slots: { start: string; end: string; label: string }[] = [];
    for (let i = 0; i <= days; i++) {
        const day = new Date(Date.UTC(localToday[0], localToday[1] - 1, localToday[2] + i));
        if (!s.workDays.includes(day.getUTCDay())) continue;
        const [y, m, d] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()];
        const dayEnd = zonedToUtc(y, m, d, eh, em, s.tz).getTime();
        for (let t = zonedToUtc(y, m, d, sh, sm, s.tz).getTime(); t + s.minutes * 60_000 <= dayEnd; t += step) {
            const start = new Date(t);
            const end = new Date(t + s.minutes * 60_000);
            if (t < earliest || end > to) continue;
            const pad = s.buffer * 60_000;
            if (blocked.some((b) => b.start.getTime() < end.getTime() + pad && b.end.getTime() > start.getTime() - pad)) continue;
            slots.push({ start: start.toISOString(), end: end.toISOString(), label: label(start, end, s.tz) });
        }
    }
    return { timezone: s.tz, meetingMinutes: s.minutes, slots };
}

// a few slots on different days, for the reply agent to offer verbatim
export async function offerableSlots(organizationId: Id, count = 3) {
    if (!await IntegrationConnection.exists({ organizationId, provider: "google_calendar", status: "connected" })) return null;
    try {
        const { slots } = await availability(organizationId, { days: 10 });
        const seen = new Set<string>();
        return slots.filter((s) => { const d = s.label.split(",")[0]; if (seen.has(d)) return false; seen.add(d); return true; }).slice(0, count).map((s) => s.label);
    } catch (error) {
        logger.warn({ error: (error as Error).message }, "Could not read calendar availability");
        return null;
    }
}

async function assertBookable(organizationId: Id, start: Date, ignoreMeetingId?: Id) {
    const { slots, meetingMinutes, timezone } = await availability(organizationId, { from: new Date(start.getTime() - 60_000), days: 1 });
    const ok = slots.some((s) => s.start === start.toISOString());
    if (!ok && !(ignoreMeetingId && await Meeting.exists({ organizationId, _id: ignoreMeetingId, start }))) {
        throw new Conflict("That time is no longer free. Pick another slot.");
    }
    return { end: new Date(start.getTime() + meetingMinutes * 60_000), timezone };
}

async function slotShape(organizationId: Id, start: Date) {
    const s = await settingsFor(organizationId);
    return { end: new Date(start.getTime() + s.minutes * 60_000), timezone: s.tz };
}

// the same booking (tenant, lead, time) always maps to the same provider event id
const eventIdFor = (organizationId: Id, leadId: Id, start: Date) => `es${createHash("sha256").update(`${organizationId}:${leadId}:${start.toISOString()}`).digest("hex").slice(0, 30)}`;

async function confirm(organizationId: Id, leadId: Id, text: string, userId: string, key: string) {
    const lead = await Lead.findOne({ organizationId, _id: leadId }).lean();
    if (!lead?.contact?.email) return;
    const conversation = await ensureConversation(String(organizationId), lead._id);
    await proposeOutbound({
        organizationId: lead.organizationId, lead, conversationId: conversation._id, kind: "reply", subject: `Re: ${conversation.subject ?? "Our call"}`,
        body: text, idempotencyKey: key, actor: { type: "user", id: userId },
    });
}

/*
    Book: re-check the slot against live availability, hold it (a unique index makes a
    concurrent booking of the same time fail), create the provider event with a
    deterministic id (a retry adopts the existing event), and only then confirm.
*/
export async function bookMeeting(organizationId: Id, input: { leadId: string; start: Date; inviteProspect: boolean; title?: string }, userId: string) {
    const lead = await Lead.findOne({ organizationId, _id: input.leadId }).lean();
    if (!lead) throw new NotFound("Lead not found");
    if (input.inviteProspect && !lead.contact?.email) throw new BadRequest("The lead has no email address to invite");
    const conn = await IntegrationConnection.findOne({ organizationId, provider: "google_calendar", status: "connected" }).lean();
    if (!conn) throw new NotFound("Google Calendar is not connected");
    const externalEventId = eventIdFor(organizationId, lead._id, input.start);
    // retrying a booking whose provider response was lost: that time now shows busy because of our own
    // unconfirmed event, so skip the free/busy check; the unique hold still stops anyone else taking it
    const retry = await Meeting.exists({ organizationId, externalEventId, status: "failed" });
    const { end, timezone } = retry ? await slotShape(organizationId, input.start) : await assertBookable(organizationId, input.start);
    const title = input.title?.trim() || `${lead.company.name} × ${(await Organization.findById(organizationId, { name: 1 }).lean())?.name ?? "us"}`;

    let meeting;
    const fields = {
        organizationId, leadId: lead._id, connectionId: conn._id, start: input.start, end, timezone, status: "booking", externalEventId,
        inviteProspect: input.inviteProspect, attendees: input.inviteProspect ? [lead.contact!.email!] : [], title, bookedBy: userId,
    };
    try {
        // retrying a booking whose outcome was unknown reuses that attempt (same deterministic event id)
        meeting = await Meeting.findOneAndUpdate({ organizationId, externalEventId, status: "failed" }, { ...fields, $unset: { cancelledReason: 1 } }, { new: true })
            ?? await Meeting.create(fields);
    } catch (error) {
        if ((error as { code?: number }).code === 11000) throw new Conflict("That time was just booked. Pick another slot.");
        throw error;
    }
    try {
        const ev = await withProvider(organizationId, "google_calendar", (token) => googleCalendar.createEvent(token, {
            id: externalEventId, start: input.start, end, timezone, summary: title, description: `Booked with easySales for ${lead.company.name}.`,
            attendees: meeting.attendees, sendInvites: input.inviteProspect,
        }));
        meeting.status = "booked";
        meeting.meetLink = ev.link;
        await meeting.save();
    } catch (error) {
        // nothing confirmed: free the slot so it can be booked again
        await Meeting.updateOne({ organizationId, _id: meeting._id }, { status: "failed", cancelledReason: (error as Error).message.slice(0, 200) });
        throw error;
    }
    await emitSalesEvent(organizationId, lead._id, "meeting.booked", String(meeting._id));
    await audit({ organizationId, actorType: "user", actorId: userId, action: "meeting.booked", targetType: "lead", targetId: String(lead._id), outcome: "success", metadata: { start: input.start, invited: input.inviteProspect } });
    await confirm(organizationId, lead._id, `Confirmed: ${label(input.start, end, timezone)}.${meeting.meetLink ? ` Join here: ${meeting.meetLink}` : ""}${input.inviteProspect ? " A calendar invitation is on its way." : ""}`, userId, `meeting:${meeting._id}:confirm`);
    return meeting;
}

export async function rescheduleMeeting(organizationId: Id, meetingId: string, start: Date, userId: string) {
    const m = await Meeting.findOne({ organizationId, _id: meetingId, status: { $in: ["booked", "rescheduled"] } });
    if (!m) throw new NotFound("Meeting not found or not active");
    const { end, timezone } = await assertBookable(organizationId, start, m._id);
    const old = { start: m.start, end: m.end };
    try {
        m.set({ start, end, status: "rescheduled" });
        await m.save();
    } catch (error) {
        if ((error as { code?: number }).code === 11000) throw new Conflict("That time was just booked. Pick another slot.");
        throw error;
    }
    try {
        await withProvider(organizationId, "google_calendar", (token) => googleCalendar.updateEvent(token, m.externalEventId, { start, end, timezone, sendInvites: m.inviteProspect }));
    } catch (error) {
        await Meeting.updateOne({ organizationId, _id: m._id }, old);
        throw error;
    }
    await audit({ organizationId, actorType: "user", actorId: userId, action: "meeting.rescheduled", targetType: "lead", targetId: String(m.leadId), outcome: "success", metadata: { from: old.start, to: start } });
    await confirm(organizationId, m.leadId, `Updated: our call is now ${label(start, end, timezone)}.`, userId, `meeting:${m._id}:reschedule:${start.toISOString()}`);
    return m;
}

export async function cancelMeeting(organizationId: Id, meetingId: string, userId: string, reason = "Cancelled") {
    const m = await Meeting.findOne({ organizationId, _id: meetingId, status: { $in: ACTIVE } });
    if (!m) throw new NotFound("Meeting not found or not active");
    await withProvider(organizationId, "google_calendar", (token) => googleCalendar.deleteEvent(token, m.externalEventId, m.inviteProspect));
    m.set({ status: "cancelled", cancelledReason: reason });
    await m.save();
    await emitSalesEvent(organizationId, m.leadId, "meeting.cancelled", String(m._id));
    await audit({ organizationId, actorType: "user", actorId: userId, action: "meeting.cancelled", targetType: "lead", targetId: String(m.leadId), outcome: "success", metadata: { reason } });
    return m;
}

/*
    The calendar provider owns event status: cancellations and moves made in Google Calendar
    are read back here.
    ponytail: one read per upcoming meeting every few minutes; switch to push channels + sync tokens past a few hundred meetings.
*/
export async function reconcileMeetings() {
    const upcoming = await Meeting.find({ status: { $in: ["booked", "rescheduled"] }, end: { $gt: new Date() } }).limit(200).setOptions({ crossTenant: true });
    for (const m of upcoming) {
        try {
            const ev = await withProvider(m.organizationId, "google_calendar", (token) => googleCalendar.getEvent(token, m.externalEventId));
            if (!ev || ev.status === "cancelled") {
                m.set({ status: "cancelled", cancelledReason: "Cancelled in Google Calendar" });
                await m.save();
                await audit({ organizationId: m.organizationId, actorType: "system", actorId: "calendar:sync", action: "meeting.cancelled", targetType: "lead", targetId: String(m.leadId), outcome: "success", metadata: { via: "provider" } });
            } else if (ev.start.getTime() !== m.start.getTime()) {
                m.set({ start: ev.start, end: ev.end, status: "rescheduled" });
                await m.save().catch(() => Meeting.updateOne({ organizationId: m.organizationId, _id: m._id }, { status: "rescheduled", end: ev.end }));
                await audit({ organizationId: m.organizationId, actorType: "system", actorId: "calendar:sync", action: "meeting.rescheduled", targetType: "lead", targetId: String(m.leadId), outcome: "success", metadata: { via: "provider", to: ev.start } });
            }
        } catch (error) {
            logger.warn({ meetingId: String(m._id), error: (error as Error).message }, "Meeting reconcile failed");
        }
    }
}
