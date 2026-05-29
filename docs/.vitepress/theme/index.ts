import type { Theme } from "vitepress";
import Layout from "./Layout.vue";
import Card from "./Card.vue";
import CardGrid from "./CardGrid.vue";
import "./styles.css";

export default {
  Layout,
  enhanceApp({ app }) {
    app.component("Card", Card);
    app.component("CardGrid", CardGrid);
  }
} satisfies Theme;
