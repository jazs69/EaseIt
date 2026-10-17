/**
 * The verification-code email.
 *
 * ===========================================================================
 * Built as a string here rather than through a template engine: it is one
 * message, and a templating dependency would buy nothing (CLAUDE.md
 * section 6.4). Four constraints shape the markup, and all four are the
 * reason it does not look like the web app's JSX:
 *
 *   * **Tables and inline styles.** Outlook renders with Word's engine, where
 *     flex, grid, `<style>` blocks and most selectors are unreliable. Every
 *     rule here is a `style` attribute on a table cell.
 *   * **Dark mode is declared, not assumed.** `color-scheme` and
 *     `supported-color-schemes` tell Gmail, Apple Mail and Outlook that this
 *     message is already dark. Without them those clients "helpfully" invert
 *     a dark email and produce grey-on-grey digits nobody can read.
 *   * **No external images.** Most clients block remote content by default, so
 *     a hosted logo would be a broken box on first open — and a remote image
 *     is also a read receipt the recipient never agreed to. The mark is drawn
 *     with a table cell and a background colour.
 *   * **No links at all.** A security-code email with a clickable button
 *     trains staff to click buttons in security-code emails, which is exactly
 *     the behaviour the second factor exists to resist.
 *
 * The text part is not a courtesy. It is what plain-text clients, screen
 * readers in text mode, watch notifications and most spam filters actually
 * read.
 * ===========================================================================
 */

import { TWO_FACTOR } from '@repo/types';

import { formatOtpForDisplay } from './otp-code.js';

export interface OtpEmailContext {
  code: string;
  /** Minutes the code remains valid, for the copy. */
  expiresInMinutes: number;
  firstName: string;
  /** Resolved from the request, e.g. "Chrome on Windows". Omitted if unknown. */
  deviceDescription?: string;
  ipAddress?: string;
}

/* -------------------------------------------------------------------------- */
/*  Palette                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Hex, not oklch: email clients have no CSS custom properties and patchy
 * support for modern colour spaces. These are the sRGB equivalents of the dark
 * theme in `packages/config/tailwind/preset.css`, so the email and the admin
 * app read as the same product.
 */
const C = {
  page: '#09090b',
  frame: '#121214',
  card: '#0e0e10',
  border: '#232327',
  slot: '#16161a',
  slotBorder: '#2c2c31',
  text: '#fafafa',
  muted: '#a1a1aa',
  faint: '#71717a',
  dim: '#52525b',
  accent: '#2563eb',
  warnBg: '#1c1509',
  warnBorder: '#45320f',
  warnText: '#fbbf24',
  warnHeading: '#fcd34d',
} as const;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const OTP_EMAIL_SUBJECT_PREFIX = 'EaseIt verification code';

export function otpEmailSubject(code: string): string {
  // The code in the subject is a deliberate convenience: it shows in the
  // notification toast, so an operator at a front desk does not have to open
  // the message at all. It is the same secret either way — a subject line is
  // no more exposed than the body.
  return `${code} is your ${OTP_EMAIL_SUBJECT_PREFIX}`;
}

/* -------------------------------------------------------------------------- */
/*  Text part                                                                 */
/* -------------------------------------------------------------------------- */

export function otpEmailText(context: OtpEmailContext): string {
  const lines = [
    `Hello ${context.firstName},`,
    '',
    `Your EaseIt verification code is:`,
    '',
    `    ${formatOtpForDisplay(context.code)}`,
    '',
    `It expires in ${String(context.expiresInMinutes)} minutes and can be used once.`,
    '',
  ];

  if (context.deviceDescription !== undefined || context.ipAddress !== undefined) {
    lines.push('This sign-in was requested from:');
    if (context.deviceDescription !== undefined) {
      lines.push(`  Device: ${context.deviceDescription}`);
    }
    if (context.ipAddress !== undefined) {
      lines.push(`  IP address: ${context.ipAddress}`);
    }
    lines.push('');
  }

  lines.push(
    'If you did not try to sign in, someone else may know your password. Do not',
    'enter this code — change your password and tell your property administrator.',
    '',
    'EaseIt Hospitality Systems',
    'Automated message; nobody monitors replies. EaseIt staff will never ask you',
    'for this code.',
  );

  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/*  HTML part                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One digit slot, mirroring the boxed inputs on the verification screen so the
 * email and the form it is typed into look like the same system.
 *
 * `font-family` lists a monospace stack because the digits sit in fixed-width
 * boxes: a proportional "1" leaves the box visibly off-centre next to a "0".
 */
function digitCell(digit: string): string {
  return (
    `<td align="center" valign="middle" style="width:46px;height:58px;` +
    `background:${C.slot};border:1px solid ${C.slotBorder};border-radius:12px;` +
    `font-family:'SF Mono',SFMono-Regular,ui-monospace,Menlo,Consolas,monospace;` +
    `font-size:27px;font-weight:700;line-height:58px;color:${C.text};` +
    `mso-line-height-rule:exactly;">${escapeHtml(digit)}</td>` +
    `<td style="width:8px;font-size:0;line-height:0;">&nbsp;</td>`
  );
}

function requestedFromBlock(context: OtpEmailContext): string {
  const rows: string[] = [];

  const add = (label: string, value: string): void => {
    rows.push(
      `<tr>` +
        `<td style="padding:3px 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:${C.dim};">${label}</td>` +
        `<td style="padding:3px 0 3px 18px;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:${C.muted};">${escapeHtml(value)}</td>` +
        `</tr>`,
    );
  };

  if (context.deviceDescription !== undefined) add('Device', context.deviceDescription);
  if (context.ipAddress !== undefined) add('IP address', context.ipAddress);

  if (rows.length === 0) return '';

  return (
    `<tr><td style="padding:4px 32px 26px 32px;">` +
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-top:1px solid ${C.border};">` +
        `<tr><td colspan="2" style="padding:18px 0 6px 0;font-family:Arial,Helvetica,sans-serif;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:${C.dim};">Requested from</td></tr>` +
        rows.join('') +
      `</table>` +
    `</td></tr>`
  );
}

export function otpEmailHtml(context: OtpEmailContext): string {
  const digits = context.code.split('').map(digitCell).join('');
  const firstName = escapeHtml(context.firstName);
  const minutes = String(context.expiresInMinutes);

  return `<!doctype html>
<html lang="en" style="color-scheme:dark;supported-color-schemes:dark;">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <!-- Tells Gmail / Apple Mail / Outlook the message is already dark, so they
         do not invert it into unreadable grey-on-grey. -->
    <meta name="color-scheme" content="dark" />
    <meta name="supported-color-schemes" content="dark" />
    <title>${escapeHtml(OTP_EMAIL_SUBJECT_PREFIX)}</title>
    <!--[if mso]>
      <style>
        /* Word's engine ignores border-radius and web fonts; keep it legible. */
        td, div, span { font-family: Arial, Helvetica, sans-serif !important; }
      </style>
    <![endif]-->
  </head>
  <body style="margin:0;padding:0;background:${C.page};-webkit-font-smoothing:antialiased;">
    <!-- Preheader: the grey line next to the subject in an inbox list. The
         trailing entities stop the client padding it out with body copy. -->
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">
      Your ${String(TWO_FACTOR.CODE_LENGTH)}-digit code is ${escapeHtml(context.code)}. It expires in ${minutes} minutes.
      &#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;
    </div>

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${C.page};">
      <tr>
        <td align="center" style="padding:40px 16px;">

          <!-- Outer frame: the muted border the verification card sits inside
               on the web, reproduced as a 4px inset. -->
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:468px;background:${C.frame};border-radius:24px;">
            <tr><td style="padding:4px;">

              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${C.card};border:1px solid ${C.border};border-radius:20px;">

                <!-- Brand -->
                <tr>
                  <td align="center" style="padding:36px 32px 0 32px;">
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td align="center" valign="middle" style="width:52px;height:52px;background:${C.accent};border-radius:14px;font-family:Arial,Helvetica,sans-serif;font-size:24px;font-weight:700;line-height:52px;color:#ffffff;mso-line-height-rule:exactly;">E</td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- Heading -->
                <tr>
                  <td align="center" style="padding:22px 32px 0 32px;font-family:Arial,Helvetica,sans-serif;">
                    <h1 style="margin:0 0 8px 0;font-size:21px;font-weight:600;color:${C.text};">Verify your email</h1>
                    <p style="margin:0 0 26px 0;font-size:14px;line-height:22px;color:${C.muted};">
                      Hello ${firstName}, enter this code to finish signing in.
                    </p>
                  </td>
                </tr>

                <!-- The code -->
                <tr>
                  <td align="center" style="padding:0 32px 14px 32px;">
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${digits}</tr></table>
                  </td>
                </tr>

                <tr>
                  <td align="center" style="padding:0 32px 26px 32px;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:${C.faint};">
                    Expires in ${minutes} minutes &middot; single use
                  </td>
                </tr>

                ${requestedFromBlock(context)}

                <!-- Phishing warning -->
                <tr>
                  <td style="padding:0 32px 28px 32px;">
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${C.warnBg};border:1px solid ${C.warnBorder};border-radius:12px;">
                      <tr>
                        <td style="padding:14px 16px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:19px;color:${C.warnText};">
                          <strong style="color:${C.warnHeading};">Didn't try to sign in?</strong><br />
                          Someone else may know your password. Do not enter this code &mdash; change your password and tell your property administrator.
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- Footer -->
                <tr>
                  <td style="padding:0 32px 32px 32px;border-top:1px solid ${C.border};">
                    <p style="margin:20px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:18px;color:${C.dim};">
                      EaseIt Hospitality Systems &middot; automated message, nobody monitors replies.<br />
                      EaseIt staff will never ask you for this code.
                    </p>
                  </td>
                </tr>
              </table>

            </td></tr>
          </table>

        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/**
 * Turns a User-Agent into something a human recognises in an email.
 *
 * Intentionally crude. The alternative is a UA-parsing dependency and a
 * database of browser strings, to render one advisory line that is wrong
 * either way for anything exotic — so unknown agents are reported as unknown
 * rather than guessed at.
 */
export function describeDevice(userAgent: string | undefined): string | undefined {
  if (userAgent === undefined || userAgent.trim().length === 0) return undefined;

  const browser =
    /\bEdg\//.test(userAgent) ? 'Edge'
    : /\bOPR\/|\bOpera\b/.test(userAgent) ? 'Opera'
    : /\bChrome\//.test(userAgent) ? 'Chrome'
    : /\bFirefox\//.test(userAgent) ? 'Firefox'
    : /\bSafari\//.test(userAgent) ? 'Safari'
    : null;

  const platform =
    /\bWindows NT\b/.test(userAgent) ? 'Windows'
    : /\biPhone\b|\biPad\b/.test(userAgent) ? 'iOS'
    : /\bAndroid\b/.test(userAgent) ? 'Android'
    : /\bMac OS X\b/.test(userAgent) ? 'macOS'
    : /\bLinux\b/.test(userAgent) ? 'Linux'
    : null;

  if (browser === null && platform === null) return 'Unrecognised device';
  if (browser === null) return platform ?? undefined;
  if (platform === null) return browser;
  return `${browser} on ${platform}`;
}
