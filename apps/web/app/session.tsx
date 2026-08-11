'use client';

import { useEffect, useState } from 'react';

import { NotSignedIn, api, signIn, type User } from '../lib/api';

type State = { status: 'loading' } | { status: 'out' } | { status: 'in'; user: User };

/**
 * Who is holding the pen, in the masthead.
 *
 * Asks the API rather than reading a cookie: the session cookie is httpOnly,
 * so the browser genuinely cannot see who it is signed in as, which is the
 * point — a name this component could read would be a name a script could
 * change.
 */
export function SessionBadge() {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let live = true;
    api
      .me()
      .then((user) => live && setState({ status: 'in', user }))
      .catch((err) => {
        if (!live) return;
        // Anything that is not "signed out" is a real fault and should not be
        // dressed up as a sign-in prompt, which would send someone round a
        // loop that cannot succeed.
        if (!(err instanceof NotSignedIn)) console.error(err);
        setState({ status: 'out' });
      });
    return () => {
      live = false;
    };
  }, []);

  if (state.status === 'loading') return <span className="session" aria-hidden />;

  if (state.status === 'out') {
    return (
      <button className="session-action" onClick={() => signIn()}>
        Sign in
      </button>
    );
  }

  return (
    <span className="session">
      <span className="session-name" title={state.user.email}>
        {state.user.name}
      </span>
      <button className="session-action" onClick={() => void api.signOut()}>
        Sign out
      </button>
    </span>
  );
}
