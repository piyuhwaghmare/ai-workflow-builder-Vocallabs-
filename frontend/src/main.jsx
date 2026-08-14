import React from 'react';
import ReactDOM from 'react-dom/client';

import { ApolloProvider } from '@apollo/client/react';

import { AuthProvider } from './AuthProvider.jsx';
import { apolloClient } from './Apolloclient.js';
import App from './App.jsx';
import './index.css';

// No admin secret, no hardcoded user id here on purpose — see lib/nhost.js
// and lib/apolloClient.js. Every request now carries the SIGNED-IN user's
// own JWT, which is what makes Layer 1 (Hasura permissions) and the
// cross-org isolation test mean anything at all.
//
// Note: @nhost/react is deprecated and incompatible with the current
// @nhost/nhost-js SDK, so auth state is handled by our own AuthProvider
// (src/lib/AuthProvider.jsx) instead.

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthProvider>
      <ApolloProvider client={apolloClient}>
        <App />
      </ApolloProvider>
    </AuthProvider>
  </React.StrictMode>
);