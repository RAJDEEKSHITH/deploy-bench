import { Navigate, Outlet, useLocation } from "react-router-dom";

import { useCurrentUser } from "../../hooks/useAuth";
import {
  getApiErrorMessage,
  isUnauthorizedError,
} from "../../lib/api-error";

import { AuthLoading } from "./AuthLoading";

export const ProtectedRoute = () => {
  const location = useLocation();

  const {
    data: user,
    isPending,
    isError,
    error,
  } = useCurrentUser();

  if (isPending) {
    return <AuthLoading />;
  }

  if (isError) {
    if (isUnauthorizedError(error)) {
      return (
        <Navigate
          to="/login"
          replace
          state={{
            from: {
              pathname: location.pathname,
              search: location.search,
              hash: location.hash,
            },
          }}
        />
      );
    }

    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <p className="text-sm text-destructive">
          {getApiErrorMessage(error)}
        </p>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  return <Outlet />;
};