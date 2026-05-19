"use strict";

const rulesCards = document.querySelector("#rulesCards");
const rulesBackButton = document.querySelector("#rulesBackButton");

rulesBackButton?.addEventListener("click", () => {
  window.location.href = "index.html";
});

if (rulesCards) {
  loadRules();
} else {
  console.error("Rules container was not found.");
}

async function loadRules() {
  try {
    const response = await fetch("rules.md", { cache: "no-store" });
    if (!response.ok) {
      throw new Error("Could not load rules.md.");
    }

    const markdown = await response.text();
    const categories = parseRules(markdown);

    if (!categories.length) {
      throw new Error("No rules were found in rules.md.");
    }

    rulesCards.replaceChildren(...categories.map(renderCategorySection));
  } catch (error) {
    const card = document.createElement("article");
    card.className = "rule-card";
    card.innerHTML = `<h2>Rules Unavailable</h2><p>${escapeHtml(error.message)}</p>`;
    rulesCards.replaceChildren(card);
  }
}

function parseRules(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const categories = [];
  let currentCategory = null;
  let currentRule = null;

  for (const line of lines) {
    const categoryHeading = line.match(/^#\s+(.+?)\s*$/);
    if (categoryHeading) {
      if (currentRule && currentCategory) currentCategory.rules.push(currentRule);
      if (currentCategory) categories.push(currentCategory);
      currentCategory = {
        title: categoryHeading[1].trim(),
        rules: [],
      };
      currentRule = null;
      continue;
    }

    const ruleHeading = line.match(/^##\s+(.+?)\s*$/);
    if (ruleHeading) {
      if (!currentCategory) {
        currentCategory = {
          title: "Rules",
          rules: [],
        };
      }
      if (currentRule) currentCategory.rules.push(currentRule);
      currentRule = {
        title: ruleHeading[1].trim(),
        body: [],
      };
      continue;
    }

    if (currentRule) {
      currentRule.body.push(line);
    }
  }

  if (currentRule && currentCategory) currentCategory.rules.push(currentRule);
  if (currentCategory) categories.push(currentCategory);

  return categories
    .map((category) => ({
      title: category.title,
      rules: category.rules
        .map((rule) => ({
          title: rule.title,
          body: rule.body.join("\n").trim(),
        }))
        .filter((rule) => rule.title),
    }))
    .filter((category) => category.title && category.rules.length);
}

function renderCategorySection(category) {
  const section = document.createElement("section");
  section.className = "rules-category";

  const heading = document.createElement("h2");
  heading.className = "rules-category-title";
  heading.textContent = category.title;
  section.appendChild(heading);

  const grid = document.createElement("div");
  grid.className = "rules-grid";
  grid.replaceChildren(...category.rules.map(renderRuleCard));
  section.appendChild(grid);

  return section;
}

function renderRuleCard(rule) {
  const article = document.createElement("article");
  article.className = "rule-card";

  const heading = document.createElement("h2");
  heading.textContent = rule.title;
  article.appendChild(heading);

  const body = markdownToFragment(rule.body || "No details provided.");
  article.appendChild(body);

  return article;
}

function markdownToFragment(markdown) {
  const fragment = document.createDocumentFragment();
  const lines = markdown.split("\n");
  let list = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      list = null;
      continue;
    }

    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      if (!list) {
        list = document.createElement("ul");
        fragment.appendChild(list);
      }
      const item = document.createElement("li");
      item.innerHTML = inlineMarkdown(bullet[1]);
      list.appendChild(item);
      continue;
    }

    list = null;
    const paragraph = document.createElement("p");
    paragraph.innerHTML = inlineMarkdown(line);
    fragment.appendChild(paragraph);
  }

  return fragment;
}

function inlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`(.+?)`/g, "<code>$1</code>");
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
