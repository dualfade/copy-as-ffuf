import { defineConfig } from "@caido-community/dev";

export default defineConfig({
  id: "copy-as-ffuf",
  name: "Copy as FFUF",
  description: "Copy request as ffuf command.",
  version: "0.1.0",
  author: {
    name: "dualfade",
    email: "dualfade@vadersecurity.com",
  },
  plugins: [
    {
      kind: "frontend",
      id: "copy-as-ffuf-frontend",
      name: "Copy as FFUF Frontend",
      root: "packages/frontend",
    },
  ],
});
