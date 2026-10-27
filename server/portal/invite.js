import { ensureClerkAccount, sendClerkInvitation } from '../auth/clerk.js';
import { FlowError } from '../core/errors.js';

// Clerk emails the portal invitation. The link opens the practice sign-in
// page. If Clerk cannot send it, Flow still makes the account, as it does
// for lab staff (server/auth/routes.js).
export async function inviteToPortal(clerk, email, redirectUrl, log) {
  try {
    return await sendClerkInvitation(clerk, email, redirectUrl);
  } catch (error) {
    log.error?.(`[portal] Clerk invitation email failed: ${error.message}`);
  }
  try {
    await ensureClerkAccount(clerk, email);
  } catch (error) {
    log.error?.(`[portal] Clerk account for a portal invitation failed: ${error.message}`);
    throw new FlowError('sign_in_unavailable', 'Flow could not prepare the sign-in account. Try again shortly.');
  }
  return { emailed: false };
}

export const portalSignInUrl = (req) => `${req.protocol}://${req.get('host')}/portal/sign-in`;
