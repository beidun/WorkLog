import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  root: "web",
  plugins: [vue()],
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    // Keep the development UI on the same port used by the local handoff URL.
    // The API remains on WORKLOG_PORT (4317 by default) and is proxied below.
    port: 4328,
    proxy: {
      "/api": "http://127.0.0.1:4317",
    },
  },
});
