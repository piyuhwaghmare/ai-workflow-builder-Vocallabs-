import React from 'react';
import ReactDOM from 'react-dom/client';

import { ApolloClient, InMemoryCache, HttpLink } from '@apollo/client/core';
// React-specific Provider
import { ApolloProvider } from '@apollo/client/react';

import App from './App.jsx';
import './index.css';

const client = new ApolloClient({
  link: new HttpLink({
    // 1. Corrected Nhost Hasura Endpoint
    uri: 'https://dhvcevimcsijoxrocwet.hasura.ap-south-1.nhost.run/v1/graphql', 
    headers: {
      'x-hasura-role': 'user', 
      'x-hasura-user-id': 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      // 2. Authorizes Hasura to accept our custom x-hasura-role header during dev testing
      'x-hasura-admin-secret': 'piyush12345' 
    }
  }),
  cache: new InMemoryCache(),
});

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ApolloProvider client={client}>
      <App />
    </ApolloProvider>
  </React.StrictMode>
);