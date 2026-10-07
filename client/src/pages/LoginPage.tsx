import {
  useState,
  type FormEvent,
} from "react";

import {
  Link,
  useLocation,
  useNavigate,
} from "react-router-dom";

import { Loader2 } from "lucide-react";

import { useLogin } from "@/hooks/useAuth";
import { getApiErrorMessage } from "@/lib/api-error";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface LoginLocationState {
  from?: {
    pathname: string;
    search: string;
    hash: string;
  };
  registered?: boolean;
}

const LoginPage = () => {
  const navigate = useNavigate();
  const location = useLocation();

  const loginMutation = useLogin();

  const state =
    (location.state as LoginLocationState | null) ??
    null;

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const redirectTo = state?.from
    ? `${state.from.pathname}${state.from.search}${state.from.hash}`
    : "/dashboard";

  const handleSubmit = async (
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();

    try {
      await loginMutation.mutateAsync({
        email: email.trim(),
        password,
      });

      navigate(redirectTo, {
        replace: true,
      });
    } catch {
      // Error rendered below.
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
      <div className="w-full max-w-md rounded-xl border bg-background p-8 shadow-sm">
        <div className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight">
            Sign in
          </h1>

          <p className="mt-2 text-sm text-muted-foreground">
            Sign in to your DeployBench account.
          </p>
        </div>

        {state?.registered && (
          <div className="mb-5 rounded-md border bg-muted/50 px-4 py-3">
            <p className="text-sm">
              Account created successfully. Sign in to
              continue.
            </p>
          </div>
        )}

        <form
          onSubmit={handleSubmit}
          className="space-y-5"
        >
          <div className="space-y-2">
            <Label htmlFor="email">
              Email
            </Label>

            <Input
              id="email"
              name="email"
              type="email"
              value={email}
              onChange={(event) =>
                setEmail(event.target.value)
              }
              placeholder="you@example.com"
              autoComplete="email"
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="password">
              Password
            </Label>

            <Input
              id="password"
              name="password"
              type="password"
              value={password}
              onChange={(event) =>
                setPassword(event.target.value)
              }
              placeholder="Enter your password"
              autoComplete="current-password"
              required
          />
          </div>

          {loginMutation.error && (
            <p className="text-sm text-destructive">
              {getApiErrorMessage(
                loginMutation.error,
              )}
            </p>
          )}

          <Button
            type="submit"
            className="w-full"
            disabled={loginMutation.isPending}
          >
            {loginMutation.isPending && (
              <Loader2 className="size-4 animate-spin" />
            )}

            {loginMutation.isPending
              ? "Signing in..."
              : "Sign in"}
          </Button>
        </form>

        <p className="mt-6 text-center text-sm text-muted-foreground">
          Don't have an account?{" "}
          <Link
            to="/register"
            className="font-medium text-foreground underline underline-offset-4"
          >
            Create an account
          </Link>
        </p>
      </div>
    </main>
  );
};

export default LoginPage