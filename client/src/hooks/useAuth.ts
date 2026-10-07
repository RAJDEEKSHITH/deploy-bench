  import {
    useMutation,
    useQuery,
    useQueryClient,
  } from "@tanstack/react-query";

  import {
    getCurrentUser,
    login,
    logout,
    register,
  } from "@/api/authApi";

  import type {
    LoginInput,
    RegisterInput,
    User,
  } from "@/types/auth";

  import { getApiErrorMessage } from "@/lib/api-error";
  import { toast } from "@/components/ui/toast";

  export const authQueryKey = ["auth", "me"] as const;

  export const useCurrentUser = () =>
    useQuery<User>({
      queryKey: authQueryKey,
      queryFn: getCurrentUser,
      retry: false,
      staleTime: 5 * 60 * 1000,
    });

  export const useLogin = () => {
    const queryClient = useQueryClient();

    return useMutation({
      mutationFn: (data: LoginInput) => login(data),

      onSuccess: (response) => {
        queryClient.setQueryData<User>(
          authQueryKey,
          response.data.user,
        );

        toast.add({
          title: "Login successful",
          description: `Welcome back, ${response.data.user.name}.`,
          type: "success",
        });
      },

      onError: (error) => {
        toast.add({
          title: "Login failed",
          description: getApiErrorMessage(error),
          type: "error",
        });
      },
    });
  };

  export const useRegister = () =>
    useMutation({
      mutationFn: (data: RegisterInput) => register(data),

      onSuccess: (response) => {
        toast.add({
          title: "Account created",
          description: response.message,
          type: "success",
        });
      },

      onError: (error) => {
        toast.add({
          title: "Registration failed",
          description: getApiErrorMessage(error),
          type: "error",
        });
      },
    });

  export const useLogout = () => {
    const queryClient = useQueryClient();

    return useMutation({
      mutationFn: logout,

      onSuccess: () => {
        queryClient.clear();

        toast.add({
          title: "Logged out",
          description: "You have been logged out successfully.",
          type: "success",
        });
      },

      onError: (error) => {
        toast.add({
          title: "Logout failed",
          description: getApiErrorMessage(error),
          type: "error",
        });
      },
    });
  };