import { Navigate } from "react-router-dom";

import DashboardPage from "@/pages/DashboardPage";
import ProjectsPage from "@/pages/ProjectsPage";
import ProjectDetailsPage from "@/pages/ProjectDetailsPage";

import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import AppLayout from "@/components/layout/AppLayout";

export const ProtectedRoutes = {
  element: <ProtectedRoute />,

  children: [
    {
      path: "/",
      element: (
        <Navigate
          to="/dashboard"
          replace
        />
      ),
    },

    {
      element: <AppLayout />,

      children: [
        {
          path: "/dashboard",
          element: <DashboardPage />,
        },

        {
          path: "/projects",
          element: <ProjectsPage />,
        },

        {
          path: "/projects/:projectId",
          element: <ProjectDetailsPage />,
        },
      ],
    },
  ],
};