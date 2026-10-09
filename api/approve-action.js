import { getUserFromAuthHeader, getAdminClient } from './lib/supabaseAdmin.js';
import { allowRequest } from './lib/rateLimit.js';
import { performIrreversible } from './lib/claudeTools.js';
import { makeApproveHandler } from './lib/approveHandler.js';

export default makeApproveHandler({
  getUser: getUserFromAuthHeader,
  getAdmin: getAdminClient,
  allow: allowRequest,
  perform: (action, args, user) => performIrreversible(action, args, user),
});
