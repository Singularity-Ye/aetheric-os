import * as fs from "fs";
import * as path from "path";

export interface AlignmentResult {
  matchedNodes: { heading: string; obsidianFile: string }[];
  missingNodes: { heading: string; suggestedName: string; reason?: string }[];
}

export interface KnowledgeDiscoveryReport {
  chapterTitle: string;
  sourceMarkdown: string;
  coreKnowledge: { name: string; type: string; why: string; examWeight?: string }[];
  matchedNodes: { heading: string; obsidianFile: string }[];
  missingNodes: { heading: string; suggestedName: string; reason?: string; priority?: string }[];
  notRecommended: { name: string; reason: string }[];
  needsReview: { item: string; reason: string }[];
}

export class KnowledgeExtractorService {
  private static readonly MAX_LLM_CHAPTER_CHARS = 42000;
  private static readonly MAX_FALLBACK_NODES = 14;

  /**
   * Scans the concept repository folder for existing note filenames (without extension).
   */
  static async getExistingNodes(nodesPath: string): Promise<string[]> {
    try {
      if (!fs.existsSync(nodesPath)) {
        return [];
      }

      const nodes: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(fullPath);
            continue;
          }

          if (entry.isFile() && entry.name.endsWith(".md")) {
            const relativePath = path.relative(nodesPath, fullPath).replace(/\\/g, "/");
            nodes.push(relativePath.slice(0, -3));
          }
        }
      };

      await walk(nodesPath);
      return nodes.sort((a, b) => a.localeCompare(b));
    } catch (err) {
      console.error("Failed to read existing nodes:", err);
      return [];
    }
  }

  private static normalizeHeading(heading: string): string {
    return heading.replace(/^#+\s*/, "").trim();
  }

  private static stripHeavyMarkdownPayloads(content: string): string {
    return content
      .replace(/!\[[^\]]*\]\(data:image\/[^)]+\)/g, "[[embedded-image-omitted]]")
      .replace(/!\[[^\]]*\]\([^)]*\.(?:png|jpg|jpeg|webp|gif)(?:\?[^)]*)?\)/gi, "[[image-omitted]]")
      .replace(/<!-- formula-not-decoded -->/g, "[[FORMULA_NOT_DECODED]]")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  private static buildChapterDigest(content: string): string {
    const cleaned = this.stripHeavyMarkdownPayloads(content);
    if (cleaned.length <= this.MAX_LLM_CHAPTER_CHARS) {
      return cleaned;
    }

    const headBudget = Math.floor(this.MAX_LLM_CHAPTER_CHARS * 0.55);
    const tailBudget = this.MAX_LLM_CHAPTER_CHARS - headBudget;
    return [
      cleaned.slice(0, headBudget),
      "\n\n[[... middle of chapter omitted for token budget ...]]\n\n",
      cleaned.slice(-tailBudget),
    ].join("");
  }

  private static looksLikeHighValueHeading(heading: string): boolean {
    const normalized = heading
      .replace(/^\d+(?:\.\d+)*\s*/, "")
      .replace(/[^\p{L}\p{N}()+*| -]/gu, "")
      .trim();
    const lower = normalized.toLowerCase();

    if (!normalized || normalized.length < 4) return false;
    if (/^(chapter|introduction|overview|summary|example|examples|exercise|project|references?)\b/i.test(lower)) return false;
    if (/^\d+$/.test(normalized)) return false;

    const highValueKeywords = [
      "definition", "algorithm", "theorem", "regular expression", "finite automata",
      "automata", "dfa", "nfa", "scanner", "parser", "grammar", "closure",
      "first", "follow", "lr", "slr", "token", "syntax", "semantic", "code generation",
      "定义", "算法", "定理", "自动机", "文法", "闭包", "语法", "语义", "正规", "正则", "词法", "语法分析"
    ];

    return highValueKeywords.some(keyword => lower.includes(keyword.toLowerCase()));
  }

  private static fallbackValueNodes(headingLines: string[]): { heading: string; suggestedName: string; reason?: string }[] {
    const seen = new Set<string>();
    const nodes: { heading: string; suggestedName: string; reason?: string }[] = [];

    for (const rawHeading of headingLines) {
      const heading = this.normalizeHeading(rawHeading);
      if (!this.looksLikeHighValueHeading(heading)) continue;

      const suggestedName = heading.replace(/^\d+(?:\.\d+)*\s*/, "").trim() || heading;
      const key = suggestedName.toLowerCase();
      if (seen.has(key)) continue;

      seen.add(key);
      nodes.push({
        heading,
        suggestedName,
        reason: "标题命中核心概念/算法/定义关键词，建议人工确认后开卡。"
      });

      if (nodes.length >= this.MAX_FALLBACK_NODES) break;
    }

    return nodes;
  }

  private static extractFormulaReviewItems(content: string): { item: string; reason: string }[] {
    const reviewItems: { item: string; reason: string }[] = [];
    const formulaMatches = content.match(/Formula not decoded \(formula-\d+\)|<!--\s*formula-not-decoded\s*-->/gi) || [];
    const count = formulaMatches.length;

    if (count > 0) {
      reviewItems.push({
        item: `${count} 个公式待确认`,
        reason: "Docling 检测到公式但未能稳定转成 LaTeX；只需人工确认影响理解、考试规则或核心算法的公式。"
      });
    }

    return reviewItems;
  }

  private static fallbackDiscoveryReport(
    chapterTitle: string,
    mdFilePath: string,
    content: string,
    headingLines: string[]
  ): KnowledgeDiscoveryReport {
    const missingNodes = this.fallbackValueNodes(headingLines);
    return {
      chapterTitle,
      sourceMarkdown: path.basename(mdFilePath),
      coreKnowledge: missingNodes.map(node => ({
        name: node.suggestedName,
        type: "候选概念",
        why: node.reason || "命中核心概念/算法/定义关键词",
        examWeight: "待评估"
      })),
      matchedNodes: [],
      missingNodes,
      notRecommended: headingLines
        .map(h => this.normalizeHeading(h))
        .filter(h => !this.looksLikeHighValueHeading(h))
        .slice(0, 12)
        .map(name => ({ name, reason: "偏目录/概览/示例性质，不建议单独建卡。" })),
      needsReview: this.extractFormulaReviewItems(content)
    };
  }

  private static parseJsonObject(rawText: string): any {
    let jsonText = rawText.trim();
    if (jsonText.startsWith("```")) {
      jsonText = jsonText.replace(/^```json\s*/i, "").replace(/```$/, "").trim();
    }
    return JSON.parse(jsonText);
  }

  private static safeFileName(name: string): string {
    return name.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim() || "Untitled";
  }

  static async discoverChapter(
    mdFilePath: string,
    existingNodes: string[],
    apiKey: string,
    apiBaseUrl: string,
    chapterTitle?: string
  ): Promise<KnowledgeDiscoveryReport> {
    if (!fs.existsSync(mdFilePath)) {
      throw new Error(`Markdown file not found: ${mdFilePath}`);
    }

    const content = await fs.promises.readFile(mdFilePath, "utf8");
    const headingLines = content
      .split("\n")
      .map(line => line.trim())
      .filter(line => line.startsWith("#"));
    const resolvedTitle = chapterTitle || path.basename(mdFilePath, path.extname(mdFilePath)).replace(/_/g, " ");

    if (!apiKey) {
      return this.fallbackDiscoveryReport(resolvedTitle, mdFilePath, content, headingLines);
    }

    const chapterDigest = this.buildChapterDigest(content);
    const prompt = `You are Scriptorium, a knowledge discovery engine for an Obsidian study vault.
Your job is NOT to preserve the PDF or make one card per heading.
Your job is to discover what should enter the knowledge graph.

Subject workflow:
- PDF/Markdown is evidence and cache.
- Existing concept notes are the current knowledge graph.
- The output should guide MOC weaving and missing-node creation.

Chapter title:
${resolvedTitle}

Chapter headings:
${JSON.stringify(headingLines.map(h => this.normalizeHeading(h)), null, 2)}

Chapter content digest:
${chapterDigest}

Existing concept nodes:
${JSON.stringify(existingNodes, null, 2)}

Return a raw JSON object with this exact shape:
{
  "coreKnowledge": [
    {"name": "durable concept/algorithm/exam topic", "type": "concept|algorithm|rule|comparison|exam-template|symbol", "why": "why it matters", "examWeight": "★★★★★|★★★★☆|★★★☆☆|★★☆☆☆|★☆☆☆☆"}
  ],
  "matchedNodes": [
    {"heading": "evidence/topic from chapter", "obsidianFile": "exact existing node path/name"}
  ],
  "missingNodes": [
    {"heading": "evidence/topic from chapter", "suggestedName": "new stable card name", "reason": "why this deserves a card", "priority": "high|medium|low"}
  ],
  "notRecommended": [
    {"name": "topic/heading", "reason": "why it should stay inside MOC or source material instead of becoming a node"}
  ],
  "needsReview": [
    {"item": "formula/diagram/table/page evidence", "reason": "why human screenshot or source PDF check may help"}
  ]
}

Rules:
- Extract only the valuable knowledge structure, not the whole table of contents.
- Prefer exam-relevant concepts, algorithms, formal rules, conversion procedures, comparison tables, and common trap points.
- Use existingNodes for strict alignment. If a concept already exists, put it in matchedNodes, not missingNodes.
- Mark possible duplicate naming conflicts in needsReview.
- missingNodes should usually be 3-14 items, never filler.
- Formula OCR failures are low priority unless they represent a core rule, algorithm, or exam formula.
- Output JSON only.`;

    const requestBody = {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You output strict JSON only. No markdown fences, no prose." },
        { role: "user", content: prompt }
      ],
      temperature: 0.1,
      response_format: { type: "json_object" }
    };

    const response = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LLM API request failed: ${response.statusText} (${errorText})`);
    }

    const responseJson = await response.json();
    const parsed = this.parseJsonObject(responseJson.choices[0].message.content);

    return {
      chapterTitle: resolvedTitle,
      sourceMarkdown: path.basename(mdFilePath),
      coreKnowledge: parsed.coreKnowledge || [],
      matchedNodes: parsed.matchedNodes || [],
      missingNodes: parsed.missingNodes || [],
      notRecommended: parsed.notRecommended || [],
      needsReview: [
        ...(parsed.needsReview || []),
        ...this.extractFormulaReviewItems(content)
      ]
    };
  }

  static async writeDiscoveryReport(report: KnowledgeDiscoveryReport, discoveryPath: string): Promise<string> {
    if (!fs.existsSync(discoveryPath)) {
      await fs.promises.mkdir(discoveryPath, { recursive: true });
    }

    const coreRows = report.coreKnowledge.length > 0
      ? report.coreKnowledge.map(item => `| ${item.examWeight || "待评估"} | ${item.type || "concept"} | ${item.name} | ${item.why} |`).join("\n")
      : "| 待评估 | - | 暂无 | 请先配置 API Key 或补充章节内容。 |";

    const matched = report.matchedNodes.length > 0
      ? report.matchedNodes.map(item => `- [[${item.obsidianFile}]]：${item.heading}`).join("\n")
      : "- 暂无明确已覆盖节点";

    const missing = report.missingNodes.length > 0
      ? report.missingNodes.map(item => `- ${item.priority ? `**${item.priority}** ` : ""}[[${item.suggestedName}]]：${item.reason || item.heading}`).join("\n")
      : "- 暂无建议新建节点";

    const notRecommended = report.notRecommended.length > 0
      ? report.notRecommended.map(item => `- ${item.name}：${item.reason}`).join("\n")
      : "- 暂无";

    const needsReview = report.needsReview.length > 0
      ? report.needsReview.map(item => `- ${item.item}：${item.reason}`).join("\n")
      : "- 暂无";

    const content = `---
type: knowledge-discovery-report
chapter: "${report.chapterTitle.replace(/"/g, '\\"')}"
source_markdown: "${report.sourceMarkdown.replace(/"/g, '\\"')}"
status: 待确认
tags:
  - Scriptorium
  - 知识发现
---

# ${report.chapterTitle} Knowledge Discovery Report

> 本报告用于知识库规划：发现核心知识点、对齐已有节点、诊断缺失节点。它不是 PDF 归档稿，也不追求教材 100% 保真。

## 核心知识点

| 考试权重 | 类型 | 知识点 | 入选原因 |
| :--- | :--- | :--- | :--- |
${coreRows}

## 已覆盖节点
${matched}

## 建议新建节点
${missing}

## 不建议单独建卡
${notRecommended}

## 需要人工/截图确认
${needsReview}
`;

    const filePath = path.join(discoveryPath, `${this.safeFileName(report.chapterTitle)} Knowledge Discovery Report.md`);
    await fs.promises.writeFile(filePath, content, "utf8");
    return filePath;
  }

  /**
   * Reads a Markdown file and asks the LLM to select only high-value concept nodes.
   */
  static async extractAndAlign(
    mdFilePath: string,
    existingNodes: string[],
    apiKey: string,
    apiBaseUrl: string
  ): Promise<AlignmentResult> {
    try {
      // 1. Read Markdown content
      if (!fs.existsSync(mdFilePath)) {
        throw new Error(`Markdown file not found: ${mdFilePath}`);
      }
      const content = await fs.promises.readFile(mdFilePath, "utf8");
      
      // 2. Extract heading lines (lines starting with #, ##, ###)
      const headingLines = content
        .split("\n")
        .map(line => line.trim())
        .filter(line => line.startsWith("#"));

      if (headingLines.length === 0) {
        return { matchedNodes: [], missingNodes: [] };
      }

      // If no API key is set, return default unmatched list
      if (!apiKey) {
        return {
          matchedNodes: [],
          missingNodes: this.fallbackValueNodes(headingLines)
        };
      }

      // 3. Assemble prompt for LLM alignment
      const chapterDigest = this.buildChapterDigest(content);
      const prompt = `You are a senior curriculum architect for an Obsidian study vault.
You are NOT making one note per heading. You are deciding which parts of this chapter are genuinely worth becoming durable concept cards for exam review and long-term understanding.

Chapter headings:
${JSON.stringify(headingLines.map(h => this.normalizeHeading(h)), null, 2)}

Chapter content digest:
${chapterDigest}

And I have the following existing concept notes in my Vault:
${JSON.stringify(existingNodes, null, 2)}

Your task is to extract only the high-value knowledge nodes from this chapter and align them with existing notes.
Please output a JSON object with two fields:
1. "matchedNodes": An array of objects {"heading": "source topic or evidence text", "obsidianFile": "exact matching filename from existing nodes list"}.
2. "missingNodes": An array of objects {"heading": "source topic or evidence text", "suggestedName": "concise durable concept card name", "reason": "why this deserves a card"}.

Rules:
- Extract at most 14 missingNodes.
- Prefer concepts, definitions, algorithms, formal rules, formulas, transformations, comparison points, and exam-solving procedures.
- Do not create cards for generic headings, admin content, project manager pages, overview, introduction, examples without a reusable concept, or every numbered subsection.
- If a formula is marked [[FORMULA_NOT_DECODED]], infer from surrounding text whether the underlying concept is important, but do not invent exact formula content.
- Be strict when matching existing nodes: only match if the existing note refers to the same core concept.
- suggestedName should be stable and concise. Use Chinese for Chinese concepts, English for named technical terms.
- Output ONLY a raw valid JSON object. Do not include any explanations or conversational text outside the JSON.
`;

      const requestBody = {
        model: "gpt-4o-mini", // fallback model, or custom configured
        messages: [
          { role: "system", content: "You are a precise JSON generator. Do not output markdown blocks or conversational text. Output raw JSON only." },
          { role: "user", content: prompt }
        ],
        temperature: 0.1,
        response_format: { type: "json_object" }
      };

      const response = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`LLM API request failed: ${response.statusText} (${errorText})`);
      }

      const responseJson = await response.json();
      const rawText = responseJson.choices[0].message.content.trim();

      // Clean markdown code blocks if the LLM wrapped it
      let jsonText = rawText;
      if (jsonText.startsWith("```")) {
        jsonText = jsonText.replace(/^```json\s*/i, "").replace(/```$/, "").trim();
      }

      const alignment: AlignmentResult = JSON.parse(jsonText);
      return {
        matchedNodes: alignment.matchedNodes || [],
        missingNodes: alignment.missingNodes || []
      };
    } catch (err: any) {
      console.error("Knowledge extraction and alignment failed:", err);
      throw err;
    }
  }
}
