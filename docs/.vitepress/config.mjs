import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Suzumio",
  description: "Suzumio is a Docker-first, non-preemptive multi-agent coordination runtime.",
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
      description: "Suzumio is a Docker-first, non-preemptive multi-agent coordination runtime."
    },
    zh: {
      label: "中文",
      lang: "zh-Hans",
      title: "Suzumio",
      description: "Suzumio 是 Docker-first、非抢占式的多智能体协调运行时。"
    }
  }
});
