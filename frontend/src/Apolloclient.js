import { ApolloClient, InMemoryCache, HttpLink, split, ApolloLink } from '@apollo/client/core';
import { GraphQLWsLink } from '@apollo/client/link/subscriptions';
import { getMainDefinition } from '@apollo/client/utilities';
import { createClient } from 'graphql-ws';
import { nhost } from './Nhost';

const HASURA_HTTP = 'https://dhvcevimcsijoxrocwet.hasura.ap-south-1.nhost.run/v1/graphql';
const HASURA_WS = 'wss://dhvcevimcsijoxrocwet.hasura.ap-south-1.nhost.run/v1/graphql';

// Attaches the CURRENT user's nhost JWT on every request. Hasura verifies
// this token and reads x-hasura-user-id / x-hasura-role from its claims —
// there is no admin secret and no manually-set user id anywhere in this file.
// getUserSession() is synchronous local storage read — no network call.
function getToken() {
  return nhost.getUserSession()?.accessToken ?? null;
}

const authLink = new ApolloLink((operation, forward) => {
  const token = getToken();
  operation.setContext(({ headers = {} }) => ({
    headers: {
      ...headers,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  }));
  return forward(operation);
});

const httpLink = new HttpLink({ uri: HASURA_HTTP });

const wsLink = new GraphQLWsLink(
  createClient({
    url: HASURA_WS,
    connectionParams: () => {
      const token = getToken();
      return token ? { headers: { authorization: `Bearer ${token}` } } : {};
    },
  })
);

// Route subscriptions over websocket, everything else over http.
const splitLink = split(
  ({ query }) => {
    const def = getMainDefinition(query);
    return def.kind === 'OperationDefinition' && def.operation === 'subscription';
  },
  wsLink,
  authLink.concat(httpLink)
);

export const apolloClient = new ApolloClient({
  link: splitLink,
  cache: new InMemoryCache(),
});