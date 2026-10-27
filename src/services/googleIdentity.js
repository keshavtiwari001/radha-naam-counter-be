import { OAuth2Client } from 'google-auth-library';
import { HttpError } from '../utils/httpError.js';

const client = new OAuth2Client();

export function googlePhoto(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      && (url.hostname === 'googleusercontent.com' || url.hostname.endsWith('.googleusercontent.com'))
      ? url.href : null;
  } catch { return null; }
}

export function identityFromPayload(payload, audience, now = Date.now()) {
  if (!payload || typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 255
    || payload.aud !== audience || !['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss)
    || !Number.isFinite(payload.exp) || payload.exp * 1000 <= now
    || payload.email_verified !== true || typeof payload.email !== 'string' || payload.email.length > 320) {
    throw new HttpError(401, 'Google sign-in could not be verified. Please try again.', 'GOOGLE_TOKEN_INVALID');
  }
  const name = typeof payload.name === 'string' ? payload.name.trim().replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, 80) : '';
  return { googleSub: payload.sub, email: payload.email, displayName: name || 'Radha Devotee', photoUrl: googlePhoto(payload.picture) };
}

export async function verifyGoogleIdentity(credential, config) {
  try {
    // Verifies Google's signature and issuer, audience and expiry against its rotating keys.
    const ticket = await client.verifyIdToken({ idToken: credential, audience: config.googleClientId });
    return identityFromPayload(ticket.getPayload(), config.googleClientId);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    // Never send library errors or the credential back to the browser/logs.
    throw new HttpError(401, 'Google sign-in could not be verified. Please try again.', 'GOOGLE_TOKEN_INVALID');
  }
}
