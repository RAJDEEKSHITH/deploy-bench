import { Outlet, useLocation } from "react-router-dom";

import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "../ui/sidebar";

import { Separator } from "../ui/separator";

import AppSidebar  from "./AppSidebar";
import UserMenu from "./UserMenu";

const getPageTitle = (pathname: string): string => {
  if (pathname === "/dashboard") {
    return "Dashboard";
  }

  if (pathname === "/projects") {
    return "Projects";
  }

  if (pathname.startsWith("/projects/")) {
    return "Project";
  }

  return "DeployBench";
};

const AppLayout = () => {
  const location = useLocation();

  const pageTitle = getPageTitle(location.pathname);

  return (
    <SidebarProvider
      defaultOpen
      style={
        {
          "--sidebar-width": "15rem",
          "--sidebar-width-mobile": "18rem",
        } as React.CSSProperties
      }
    >
      <AppSidebar />

      <SidebarInset>
        <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur">
          <SidebarTrigger className="-ml-1" />

          <Separator
            orientation="vertical"
            className="mr-2 h-4"
          />

          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold">
              {pageTitle}
            </h1>
          </div>

          <UserMenu />
        </header>

        <main className="min-w-0 flex-1">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
};

export default AppLayout