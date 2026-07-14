import * as fs from "fs";
import * as path from "path";
import { AlignmentResult } from "./KnowledgeExtractorService";

export class MocGeneratorService {
  /**
   * Generates a Mermaid flowchart for the chapter using LLM.
   */
  private static async generateMermaidMap(
    headings: string[],
    apiKey: string,
    apiBaseUrl: string
  ): Promise<string> {
    if (!apiKey) {
      return `graph TD\n    Start[Chapter Outline] --> Node1[Please configure API Key to generate visual flowcharts]\n`;
    }

    try {
      const prompt = `You are a curriculum visualizer. Given the following headings from a textbook chapter, create a concise, logical Mermaid flowchart (graph TD) that shows how these topics build on or relate to each other.
Headings:
${JSON.stringify(headings, null, 2)}

Rules:
- Keep the nodes short and in Chinese/English (e.g. "DFA" or "闭包运算").
- Output ONLY the raw Mermaid flowchart code inside a fenced code block with "mermaid" language identifier (e.g., \`\`\`mermaid ... \`\`\`).
- Ensure valid Mermaid syntax. Do not write any explanations or conversational text.
`;

      const requestBody = {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2
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
        throw new Error("Failed to fetch Mermaid map from LLM");
      }

      const responseJson = await response.json();
      const rawText = responseJson.choices[0].message.content.trim();
      
      const match = rawText.match(/```mermaid([\s\S]*?)```/);
      if (match) {
        return match[1].trim();
      }
      return rawText.replace(/```/g, "").trim();
    } catch (err) {
      console.error("Failed to generate Mermaid flowchart:", err);
      return `graph TD\n    Start[Chapter Start] --> NodeErr[Failed to generate flowchart]\n`;
    }
  }

  /**
   * Generates the exam focus and weights using LLM.
   */
  private static async generateExamFocusTable(
    headings: string[],
    apiKey: string,
    apiBaseUrl: string
  ): Promise<string> {
    if (!apiKey) {
      return `| 考点权重 | 核心任务 | 关联概念节点 | 核心考题与解题模板 |\n| :--- | :--- | :--- | :--- |\n| ★★★★★ | 核心考点 | [[概念节点]] | 请配置 API Key 获取详细应试模板 |\n`;
    }

    try {
      const prompt = `Based on the following chapter headings, list 3-4 high-frequency exam topics commonly tested in academic exams (like finals or postgraduate entrance exams).
Headings:
${JSON.stringify(headings, null, 2)}

Provide the output as a Markdown table with the following columns:
1. "考点权重" (Star rating, e.g. ★★★★★)
2. "核心任务" (Concise description of the task, e.g. "构造 SLR(1) 分析表")
3. "关联概念节点" (Suggest the core concept file name in double links, e.g. "[[SLR(1)]]")
4. "核心考题与解题模板" (Brief tips or steps on how to solve it)

Output ONLY the raw markdown table. Do not write any other text.
`;

      const requestBody = {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2
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
        throw new Error("Failed to fetch exam focus table");
      }

      const responseJson = await response.json();
      return responseJson.choices[0].message.content.trim();
    } catch (err) {
      console.error("Failed to generate exam focus table:", err);
      return `| 考点权重 | 核心任务 | 关联概念节点 | 核心考题与解题模板 |\n| :--- | :--- | :--- | :--- |\n| ★★★★★ | 核心考点 | [[概念节点]] | 提取失败 |\n`;
    }
  }

  /**
   * Generates the Chapter MOC file and saves it.
   */
  static async generateMocFile(
    chapterTitle: string,
    headings: string[],
    alignment: AlignmentResult,
    mocsPath: string,
    apiKey: string,
    apiBaseUrl: string
  ): Promise<string> {
    try {
      // 1. Generate Mermaid flow chart
      const mermaidCode = await this.generateMermaidMap(headings, apiKey, apiBaseUrl);

      // 2. Generate Exam Focus table
      const examTable = await this.generateExamFocusTable(headings, apiKey, apiBaseUrl);

      // 3. Assemble MOC Markdown content
      let existingLinks = alignment.matchedNodes
        .map(n => `- [[${n.obsidianFile}]]：关联讲义主题 "${n.heading}"`)
        .join("\n");
      if (!existingLinks) existingLinks = "- (无已匹配节点，可将新建节点关联至此)";

      let missingLinks = alignment.missingNodes
        .map(n => `- [[${n.suggestedName}]] \`(待新建)\`：关联讲义主题 "${n.heading}"`)
        .join("\n");
      if (!missingLinks) missingLinks = "- (无推荐新建节点)";

      const mocContent = `---
type: MOC
status: 待复习
tags:
  - Scriptorium
---

# ${chapterTitle}

## 1. 🌟 本章核心问题 (Why we are here?)
> 这是一张由 **引经童子** 整理的本章知识地图。
> 请在此处填写对本章节解决的核心工程或理论问题的总结。例如：这一章主要解决了如何利用语法分析算法来构建抽象语法树（AST）的问题。

---

## 🗺️ 本章知识地图 (Pipeline)
\`\`\`mermaid
${mermaidCode}
\`\`\`

---

## 🎯 🎯 考试高频考点 (Exam Focus)
${examTable}

---

## 🔗 本章知识点仓库 (Index)

### 现有硬核节点 (学术参考)
${existingLinks}

### 💡 推荐新建节点 (盲区补齐)
${missingLinks}
`;

      const safeFileName = chapterTitle.replace(/[\\/:*?"<>|]/g, "_") + ".md";
      const filePath = path.join(mocsPath, safeFileName);
      
      if (!fs.existsSync(mocsPath)) {
        fs.mkdirSync(mocsPath, { recursive: true });
      }

      await fs.promises.writeFile(filePath, mocContent, "utf8");
      return filePath;
    } catch (err: any) {
      console.error("Moc creation failed:", err);
      throw err;
    }
  }
}
