/**
 * The password-reset and invitation emails (AU-08, AU-14).
 *
 * Plain text first, with a minimal HTML twin. Every interpolated value is
 * escaped in the HTML part: a first name or property name is user input.
 */

import type { MailMessage } from '../platform/mail/mailer.js';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Security notices: no vacation auto-replies, no threading of successive links. */
function headers(): Record<string, string> {
  return { 'Auto-Submitted': 'auto-generated', 'X-Entity-Ref-ID': globalThis.crypto.randomUUID() };
}

function html(paragraphs: string[], link: string, button: string): string {
  return [
    '<!doctype html><html><body style="font-family:Arial,sans-serif;color:#111;line-height:1.5">',
    ...paragraphs.map((text) => `<p>${escapeHtml(text)}</p>`),
    `<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 16px;background:#111;color:#fff;text-decoration:none;border-radius:6px">${escapeHtml(button)}</a></p>`,
    `<p style="font-size:12px;color:#555">Or paste this address into your browser:<br>${escapeHtml(link)}</p>`,
    '</body></html>',
  ].join('');
}

export function passwordResetEmail(input: {
  to: string;
  firstName: string;
  link: string;
  minutes: number;
}): MailMessage {
  const lines = [
    `Hello ${input.firstName},`,
    `Someone asked to reset the password for your EaseIt account. The link below works once, for ${String(input.minutes)} minutes.`,
    'If it was not you, ignore this email: your password has not changed.',
  ];
  return {
    to: input.to,
    subject: 'Reset your EaseIt password',
    text: `${lines.join('\n\n')}\n\n${input.link}\n`,
    html: html(lines, input.link, 'Set a new password'),
    headers: headers(),
  };
}

export function invitationEmail(input: {
  to: string;
  firstName: string;
  propertyName: string;
  link: string;
  hours: number;
}): MailMessage {
  const lines = [
    `Hello ${input.firstName},`,
    `You have been invited to EaseIt at ${input.propertyName}. Set your password with the link below; it works once, for ${String(input.hours)} hours.`,
    'Signing in will also ask for a code sent to this address.',
  ];
  return {
    to: input.to,
    subject: `You're invited to EaseIt — ${input.propertyName}`,
    text: `${lines.join('\n\n')}\n\n${input.link}\n`,
    html: html(lines, input.link, 'Set your password'),
    headers: headers(),
  };
}
