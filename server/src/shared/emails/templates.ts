/*
    Account emails (verification code, password reset, invitation) in the app's look:
    forest green, lime highlight, paper background. Email clients only render simple HTML,
    so the layout is tables with inline styles. The <style> block adds a gentle pop-in and
    glow where clients support CSS animation (Apple Mail, iOS); Gmail and Outlook show
    the same design without motion. Every dynamic value is HTML-escaped.
*/
import env from "../config/env.config.js";

const C = { forest: "#0f3d2e", forest2: "#145a43", lime: "#c8f169", paper: "#f4f7f3", card: "#ffffff", ink: "#0e1f18", muted: "#5d6e66", line: "#e2e9e4" };
const FONT = "'Geist','Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export const escapeHtml = (v: string) => v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const STYLE = `
  @keyframes es-pop { 0% { opacity: 0; transform: translateY(10px) scale(.85); } 70% { opacity: 1; transform: translateY(-2px) scale(1.04); } 100% { opacity: 1; transform: none; } }
  @keyframes es-glow { 0%, 100% { box-shadow: 0 0 0 0 rgba(200,241,105,0); } 50% { box-shadow: 0 0 0 6px rgba(200,241,105,.45); } }
  @keyframes es-rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
  @media screen {
    .es-card { animation: es-rise .6s ease-out both; }
    .es-digit { animation: es-pop .5s cubic-bezier(.2,.9,.3,1.3) both; }
    .es-code { animation: es-glow 2.4s ease-in-out .9s 3; border-radius: 18px; }
  }
  @media (prefers-reduced-motion: reduce) { .es-card, .es-digit, .es-code { animation: none !important; } }
  @media only screen and (max-width: 520px) { .es-pad { padding: 28px 22px !important; } .es-digit-cell { width: 40px !important; height: 52px !important; font-size: 26px !important; } }
`;

function layout(o: { preheader: string; heading: string; intro: string; body: string; footnote: string }) {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<title>${escapeHtml(o.heading)}</title><style>${STYLE}</style></head>
<body style="margin:0;padding:0;background:${C.paper};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(o.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.paper};"><tr><td align="center" style="padding:36px 14px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
    <tr><td style="padding:0 6px 18px;">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="width:30px;height:30px;background:${C.forest};border-radius:9px;text-align:center;vertical-align:middle;color:${C.lime};font:700 16px ${FONT};">&#8599;</td>
        <td style="padding-left:9px;font:700 18px ${FONT};color:${C.forest};letter-spacing:-.3px;">easy<span style="color:${C.forest2};">Sales</span></td>
      </tr></table>
    </td></tr>
    <tr><td class="es-card es-pad" style="background:${C.card};border:1px solid ${C.line};border-radius:24px;padding:36px 34px;">
      <div style="display:inline-block;background:${C.paper};border:1px solid ${C.line};border-radius:999px;padding:4px 11px;font:600 12px ${FONT};color:${C.forest2};">&#9679;&nbsp; ${escapeHtml(o.preheader)}</div>
      <h1 style="margin:16px 0 8px;font:700 26px/1.2 ${FONT};color:${C.ink};letter-spacing:-.6px;">${escapeHtml(o.heading)}</h1>
      <p style="margin:0 0 24px;font:400 15px/1.6 ${FONT};color:${C.muted};">${o.intro}</p>
      ${o.body}
      <p style="margin:26px 0 0;padding-top:18px;border-top:1px solid ${C.line};font:400 13px/1.6 ${FONT};color:${C.muted};">${o.footnote}</p>
    </td></tr>
    <tr><td align="center" style="padding:20px 10px 0;font:400 12px/1.6 ${FONT};color:${C.muted};">easySales &middot; your AI business development team<br><a href="${escapeHtml(env.FRONTEND_URL)}" style="color:${C.forest2};">${escapeHtml(env.FRONTEND_URL.replace(/^https?:\/\//, ""))}</a></td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

const button = (href: string, label: string) => `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:${C.lime};border-radius:999px;">
  <a href="${escapeHtml(href)}" style="display:inline-block;padding:13px 26px;font:700 15px ${FONT};color:${C.forest};text-decoration:none;">${escapeHtml(label)} &rarr;</a>
</td></tr></table>`;

export function otpEmail(code: string, minutes: number) {
    // one highlighted box per digit, popping in one after another
    const digits = [...code].map((d, i) => `<td class="es-digit es-digit-cell" style="width:48px;height:60px;background:${C.lime};border-radius:12px;text-align:center;vertical-align:middle;font:700 32px 'Geist Mono',Menlo,Consolas,monospace;color:${C.forest};animation-delay:${0.25 + i * 0.09}s;">${escapeHtml(d)}</td>${i < code.length - 1 ? '<td style="width:8px;"></td>' : ""}`).join("");
    return {
        subject: `${code} is your easySales code`,
        html: layout({
            preheader: "Verify your email",
            heading: "Here's your code",
            intro: "Enter this code in easySales to verify your email and finish setting up your workspace.",
            body: `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;"><tr><td class="es-code" style="padding:14px;background:${C.forest};border-radius:18px;">
                <table role="presentation" cellpadding="0" cellspacing="0" aria-label="Verification code ${escapeHtml(code.split("").join(" "))}"><tr>${digits}</tr></table>
              </td></tr></table>
              <p style="margin:16px 0 0;text-align:center;font:600 13px ${FONT};color:${C.forest2};">Expires in ${minutes} minutes</p>
              <!-- email apps can't run a copy script: one tap selects the whole code (user-select: all), and the button fills it in for you -->
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px auto 0;"><tr>
                <td style="padding:0 10px 0 0;font:600 12px ${FONT};color:${C.muted};">Tap to copy</td>
                <td class="es-copy" style="padding:9px 16px;border:2px dashed ${C.forest2};border-radius:12px;background:${C.paper};font:700 20px 'Geist Mono',Menlo,Consolas,monospace;letter-spacing:4px;color:${C.forest};-webkit-user-select:all;user-select:all;cursor:copy;">${escapeHtml(code)}</td>
              </tr></table>
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin:18px auto 0;"><tr><td style="background:${C.lime};border-radius:999px;">
                <a href="${escapeHtml(`${env.FRONTEND_URL.replace(/\/$/, "")}/verify#code=${code}`)}" style="display:inline-block;padding:12px 24px;font:700 14px ${FONT};color:${C.forest};text-decoration:none;">Verify in one click &rarr;</a>
              </td></tr></table>`,
            footnote: "Didn't try to sign up? You can ignore this email; nothing happens without the code. Never share it with anyone, including us.",
        }),
        text: `Your easySales verification code is ${code}. It expires in ${minutes} minutes.\nOr verify in one click: ${env.FRONTEND_URL.replace(/\/$/, "")}/verify#code=${code}\nIf you didn't try to sign up, ignore this email.`,
    };
}

export function resetEmail(link: string, minutes: number) {
    return {
        subject: "Reset your easySales password",
        html: layout({
            preheader: "Password reset",
            heading: "Reset your password",
            intro: `Someone asked to reset the password for this email. If it was you, choose a new one below. The link works for ${minutes} minutes and only once.`,
            body: button(link, "Choose a new password"),
            footnote: `Button not working? Paste this link into your browser:<br><a href="${escapeHtml(link)}" style="color:${C.forest2};word-break:break-all;">${escapeHtml(link)}</a><br><br>Didn't ask for this? Ignore this email; your password stays the same.`,
        }),
        text: `Reset your easySales password (valid ${minutes} minutes, once): ${link}\nIf you didn't ask for this, ignore this email.`,
    };
}

export function inviteEmail(orgName: string, role: string, link: string) {
    return {
        subject: `You're invited to ${orgName} on easySales`,
        html: layout({
            preheader: "Team invitation",
            heading: `Join ${orgName}`,
            intro: `You've been invited to <b style="color:${C.ink};">${escapeHtml(orgName)}</b> on easySales as <b style="color:${C.ink};">${escapeHtml(role)}</b>. Sign in, or create an account with this email address, to accept.`,
            body: button(link, "Accept the invitation"),
            footnote: "Not expecting this? You can ignore this email.",
        }),
        text: `You're invited to ${orgName} on easySales as ${role}. Sign in or create an account with this email: ${link}`,
    };
}
