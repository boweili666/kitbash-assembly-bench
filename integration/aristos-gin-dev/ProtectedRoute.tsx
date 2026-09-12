import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';

import { getUserContext } from '../UserContext/UserContext.tsx';

interface ProtectedRouteProps {
	children: ReactNode;
}

// Signed-out visitors go to /login.  Roles do not gate routes: every account
// can work as either a trainee or a contributor, and picks which in the app.
export default function ProtectedRoute({ children }: ProtectedRouteProps) {

	const userContext = getUserContext();

	// A token left over from a previous page load is still being checked.
	// Render nothing rather than bouncing a signed-in user to /login for the
	// moment it takes the backend to answer.
	if(userContext.isRestoring) {
		return null;
	}

	// Demo bypass: with VITE_DEMO_NO_AUTH=1 in .env.local the dev server opens
	// the signed-in pages without an account, so the simulation demo can be
	// shown while the local backend still predates the login flow.  Guarded by
	// import.meta.env.DEV, so a production build always requires signing in.
	const demoNoAuth = import.meta.env.DEV
		&& import.meta.env.VITE_DEMO_NO_AUTH === '1';

	if(!userContext.accessToken && !demoNoAuth) {
		return <Navigate to="/login" replace={true} />
	}

	return children;
}
