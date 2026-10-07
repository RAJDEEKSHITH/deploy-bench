import { RouterProvider } from "react-router-dom";

import { router } from "./routes";
import { Toaster } from "./components/ui/toast";
import { TooltipProvider } from "./components/ui/tooltip";

const App = () => {
  return (
    <TooltipProvider>
      <RouterProvider router={router} />
      <Toaster />
    </TooltipProvider>
  );
};

export default App;