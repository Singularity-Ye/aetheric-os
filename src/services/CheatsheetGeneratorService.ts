import * as fs from "fs";
import * as path from "path";

export class CheatsheetGeneratorService {
  /**
   * Generates a condensed exam cheatsheet based on the converted Markdown lecture notes in the subject.
   */
  static async generateCheatsheet(
    subjectName: string,
    mdPath: string,
    cheatsheetPath: string,
    apiKey: string,
    apiBaseUrl: string
  ): Promise<string> {
    try {
      // 1. Gather all MD file contents or outlines in `原始资料-md`
      if (!fs.existsSync(mdPath)) {
        throw new Error(`Markdown source path does not exist: ${mdPath}`);
      }
      
      const files = await fs.promises.readdir(mdPath);
      const mdFiles = files.filter(f => f.endsWith(".md"));
      
      let courseOutline = "";
      for (const file of mdFiles) {
        const filePath = path.join(mdPath, file);
        const content = await fs.promises.readFile(filePath, "utf8");
        // Read first 1500 chars to capture structure and main ideas
        courseOutline += `\n--- File: ${file} ---\n${content.slice(0, 1500)}...\n`;
      }

      if (!courseOutline) {
        courseOutline = "No converted lecture notes found in this subject yet.";
      }

      // If no API Key is set, create a default template
      if (!apiKey) {
        const defaultContent = `# ⚡ ${subjectName} 考前速记汇总\n\n> [!NOTE]\n> 请配置 API Key 并点击 [凝练考前速记] 以基于讲义自动提取考试核心对比表、算法流程及关键公式。`;
        const defaultFilePath = path.join(cheatsheetPath, `${subjectName} - 考前速记.md`);
        await fs.promises.writeFile(defaultFilePath, defaultContent, "utf8");
        return defaultFilePath;
      }

      // 2. Query LLM to generate cheatsheet content
      const prompt = `You are an expert exam preparation assistant.
Below are summarized lecture contents from a university course named "${subjectName}":
${courseOutline}

Please write a highly condensed, dense, 3-page exam Cheatsheet (考前超强速记) in Markdown for this course.
It must contain:
1. "⚔️ 核心对比专题" (Core Comparison Tables): Compare the main algorithms, architectures, models, or protocols in this course side-by-side using Markdown tables (e.g. for Compile Theory: LR0 vs SLR1 vs LR1 vs LALR1; for OS: Scheduling algorithms, etc.).
2. "🛠️ 必背算法与标准解题模板" (Key Algorithms and Exam Step-by-Step templates): The absolute essential step-by-step algorithms required for solving big exam problems.
3. "📐 必背公式、符号与关键定理" (Essential Formulas, notations, and theorems).

Rules:
- Keep the language in Chinese.
- Focus on density and high-frequency exam points. Avoid filler text.
- Do not write any explanations or chat outside the Markdown content. Start directly with the title: "# ⚡ ${subjectName} 考前超强速记".
`;

      const requestBody = {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3
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
        throw new Error("Failed to fetch cheatsheet from LLM");
      }

      const responseJson = await response.json();
      const cheatsheetContent = responseJson.choices[0].message.content.trim();

      // 3. Save to cheatsheet path
      if (!fs.existsSync(cheatsheetPath)) {
        fs.mkdirSync(cheatsheetPath, { recursive: true });
      }

      const fileName = `${subjectName} - 考前速记.md`;
      const filePath = path.join(cheatsheetPath, fileName);
      
      await fs.promises.writeFile(filePath, cheatsheetContent, "utf8");
      return filePath;
    } catch (err: any) {
      console.error("Failed to generate cheatsheet:", err);
      throw err;
    }
  }
}
