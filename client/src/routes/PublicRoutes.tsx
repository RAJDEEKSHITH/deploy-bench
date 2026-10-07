import  LoginPage  from "@/pages/LoginPage";
import  RegisterPage  from "@/pages/RegisterPage";
import { PublicRoute } from "@/components/auth/PublicRoute";

export const PublicRoutes = {
  element: <PublicRoute />,
  children: [
    {
      path: "/login",
      element: <LoginPage />,
    },
    {
      path: "/register",
      element: <RegisterPage />,
    },
  ],
};