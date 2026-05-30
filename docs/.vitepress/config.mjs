import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Suzumio",
  description: "Suzumio is a YAML-based multi-agent system that runs agents in Docker activations.",
  head: [["meta", { name: "theme-color", content: "#2f9e55" }]],
  vite: {
    build: {
      target: "es2022"
    },
    esbuild: {
      target: "es2022",
      tsconfigRaw: {
        compilerOptions: {
          target: "ES2022"
        }
      }
    }
  },
  locales: {
    root: {
      label: "English",
      lang: "en",
      title: "Suzumio",
      description: "Suzumio is a YAML-based multi-agent system that runs agents in Docker activations."
    },
    zh: {
      label: "中文",
      lang: "zh-Hans",
      title: "Suzumio",
      description: "Suzumio 是用 Docker activation 运行 agent 团队的 YAML-based multi-agent system。"
    }
  }
});
