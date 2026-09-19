import { startNetworkService } from './network/service.mjs';
startNetworkService().catch(() => {
  // Never print persisted device credentials, invitations, profiles or raw exceptions.
  console.error('Network service could not start. Check the installed bundle and native broker.');
  process.exitCode = 1;
});
