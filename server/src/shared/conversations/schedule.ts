// Follow-up timing: event-driven, stored on the conversation as nextActionAt.

// adds n business days (Mon–Fri), keeping the time of day
export function addBusinessDays(from: Date, days: number) {
    const d = new Date(from);
    let left = days;
    while (left > 0) {
        d.setUTCDate(d.getUTCDate() + 1);
        const wd = d.getUTCDay();
        if (wd !== 0 && wd !== 6) left--;
    }
    return d;
}

/*
    When the next follow-up is due after an outbound message, or null when the sequence is done.
    `followUpsSent` is the count *after* the message that was just sent.
    Campaign cadence wins (business days); otherwise the tenant policy interval and cap apply.
*/
export function nextFollowUpAt(
    sentAt: Date,
    followUpsSent: number,
    campaign: { followUpDelaysDays: number[] } | null,
    policy: { maxFollowUps: number; minimumFollowUpIntervalHours: number },
) {
    if (campaign) {
        const delay = campaign.followUpDelaysDays[followUpsSent];
        return delay === undefined || followUpsSent >= policy.maxFollowUps ? null : addBusinessDays(sentAt, delay);
    }
    return followUpsSent >= policy.maxFollowUps ? null : new Date(sentAt.getTime() + policy.minimumFollowUpIntervalHours * 3600_000);
}
