<script setup lang="ts">
import { computed } from "vue";
import { Content, useData, withBase } from "vitepress";

type NavItem = {
  text: string;
  link: string;
};

type NavGroup = {
  title: string;
  items: NavItem[];
};

const englishNav: NavGroup[] = [
  {
    title: "Start",
    items: [
      { text: "Overview", link: "/index.html" },
      { text: "Quickstart", link: "/quickstart.html" },
      { text: "Core Concepts", link: "/concepts.html" }
    ]
  },
  {
    title: "Build",
    items: [
      { text: "Configuration", link: "/configuration.html" },
      { text: "Toolpacks", link: "/toolpacks.html" },
      { text: "CLI Reference", link: "/cli.html" },
      { text: "Architecture", link: "/architecture.html" },
      { text: "Operations", link: "/operations.html" }
    ]
  },
  {
    title: "Reference",
    items: [
      { text: "HTTP API", link: "/api.html" },
      { text: "Roadmap", link: "/roadmap.html" },
      { text: "GitHub", link: "https://github.com/OmegaCombinator/suzumio" }
    ]
  }
];

const chineseNav: NavGroup[] = [
  {
    title: "开始",
    items: [
      { text: "概览", link: "/zh/index.html" },
      { text: "快速开始", link: "/zh/quickstart.html" },
      { text: "核心概念", link: "/zh/concepts.html" }
    ]
  },
  {
    title: "构建",
    items: [
      { text: "配置", link: "/zh/configuration.html" },
      { text: "Toolpacks", link: "/zh/toolpacks.html" },
      { text: "CLI 参考", link: "/zh/cli.html" },
      { text: "架构", link: "/zh/architecture.html" },
      { text: "运维", link: "/zh/operations.html" }
    ]
  },
  {
    title: "参考",
    items: [
      { text: "HTTP API", link: "/zh/api.html" },
      { text: "路线图", link: "/zh/roadmap.html" },
      { text: "GitHub", link: "https://github.com/OmegaCombinator/suzumio" }
    ]
  }
];

const { frontmatter, page } = useData();

const isZh = computed(() => page.value.relativePath.startsWith("zh/"));
const navGroups = computed(() => (isZh.value ? chineseNav : englishNav));
const slug = computed(() => page.value.relativePath.replace(/^zh\//, "").replace(/\.md$/, ""));
const currentLink = computed(() => (isZh.value ? `/zh/${slug.value}.html` : `/${slug.value}.html`));
const alternateLink = computed(() => (isZh.value ? `/${slug.value}.html` : `/zh/${slug.value}.html`));

const mobileOptions = computed(() => [
  ...navGroups.value.flatMap((group) => group.items.filter((item) => !isExternal(item.link))),
  { text: isZh.value ? "English" : "中文", link: alternateLink.value }
]);

function isExternal(link: string) {
  return /^https?:\/\//.test(link);
}

function toHref(link: string) {
  if (isExternal(link)) return link;
  const normalized = link.startsWith("/") ? link : `${isZh.value ? "/zh/" : "/"}${link}`;
  return withBase(normalized);
}

function isActive(link: string) {
  return !isExternal(link) && link === currentLink.value;
}

function navigate(event: Event) {
  const select = event.target as HTMLSelectElement;
  window.location.href = select.value;
}
</script>

<template>
  <div class="mobile-nav">
    <select :value="toHref(currentLink)" @change="navigate">
      <option v-for="item in mobileOptions" :key="item.link" :value="toHref(item.link)">
        {{ item.text }}
      </option>
    </select>
  </div>

  <div class="shell">
    <aside class="sidebar">
      <a class="brand" :href="toHref(isZh ? '/zh/index.html' : '/index.html')"><strong>Suzumio</strong></a>

      <div class="language-switch">
        <a :class="{ active: !isZh }" :href="toHref(`/${slug}.html`)">EN</a>
        <a :class="{ active: isZh }" :href="toHref(`/zh/${slug}.html`)">中文</a>
      </div>

      <div v-for="group in navGroups" :key="group.title" class="nav-group">
        <p class="nav-title">{{ group.title }}</p>
        <a
          v-for="item in group.items"
          :key="item.link"
          class="nav-link"
          :class="{ active: isActive(item.link) }"
          :href="toHref(item.link)"
        >{{ item.text }}</a>
      </div>
    </aside>

    <main class="content">
      <section v-if="frontmatter.eyebrow || frontmatter.heroTitle || frontmatter.lead" class="hero">
        <p v-if="frontmatter.eyebrow" class="eyebrow">{{ frontmatter.eyebrow }}</p>
        <h1>{{ frontmatter.heroTitle || frontmatter.title }}</h1>
        <p v-if="frontmatter.lead" class="lead">{{ frontmatter.lead }}</p>
        <div v-if="frontmatter.actions" class="actions">
          <a
            v-for="action in frontmatter.actions"
            :key="action.link"
            class="button"
            :class="action.variant"
            :href="toHref(action.link)"
          >{{ action.text }}</a>
        </div>
      </section>

      <Content />
    </main>
  </div>
</template>
