import React from "react";
import { createRoot } from "react-dom/client";
import { ClerkProvider } from "@clerk/clerk-react";
import App from "./App";
import "./index.css";

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

if (!publishableKey) {
  console.warn("VITE_CLERK_PUBLISHABLE_KEY no está configurada. Clerk no funcionará correctamente.");
}

// Debugging Clerk setup
console.log('Clerk publishable key:', import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ClerkProvider publishableKey={publishableKey || ""}>
      <App />
    </ClerkProvider>
  </React.StrictMode>
);
