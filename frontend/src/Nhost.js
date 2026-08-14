import { createClient } from '@nhost/nhost-js';

// Subdomain/region are not secret — safe to keep in client code.
// What must NEVER be here: the Hasura admin secret. Auth happens via
// nhost's own login flow, which issues a per-user JWT that Hasura
// verifies and derives x-hasura-user-id / x-hasura-role from directly.
export const nhost = createClient({
  subdomain: 'dhvcevimcsijoxrocwet',
  region: 'ap-south-1',
});