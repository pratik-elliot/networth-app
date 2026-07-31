import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// During local development, requests to /api are forwarded to the backend
// server so the client and server can run on separate ports.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:4000",
      "/uploads": "http://localhost:4000",
    },
  },
});
