import { spawn, execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

interface FileSnapshot {
  size: number;
  mtimeMs: number;
}

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  output: string;
}

interface PdfChunkInfo {
  path: string;
  start: number;
  end: number;
}

interface PdfSplitPlan {
  totalPages: number;
  chunks: PdfChunkInfo[];
}

interface FormulaAuditEntry {
  id: string;
  context: string;
}

export class DoclingService {
  private static readonly SEGMENT_PAGE_SIZE = 15;
  private static readonly TEMP_PREFIX = "scriptorium-docling-";

  private static getExpectedMarkdownCandidates(pdfPath: string, outputDir: string): string[] {
    const pdfStem = path.basename(pdfPath, path.extname(pdfPath));
    const normalizedStem = pdfStem.replace(/\s+/g, "_");
    return Array.from(new Set([
      path.join(outputDir, `${pdfStem}.md`),
      path.join(outputDir, `${normalizedStem}.md`),
    ]));
  }

  private static getFileSnapshot(filePath: string): FileSnapshot | null {
    try {
      const stat = fs.statSync(filePath);
      return stat.isFile() ? { size: stat.size, mtimeMs: stat.mtimeMs } : null;
    } catch {
      return null;
    }
  }

  private static findGeneratedMarkdown(
    pdfPath: string,
    outputDir: string,
    startedAtMs: number,
    beforeSnapshots: Map<string, FileSnapshot | null>
  ): string | null {
    for (const candidate of this.getExpectedMarkdownCandidates(pdfPath, outputDir)) {
      const after = this.getFileSnapshot(candidate);
      if (!after || after.size <= 0) continue;

      const before = beforeSnapshots.get(candidate);
      const wasCreated = !before;
      const wasUpdated = Boolean(before && (after.mtimeMs > before.mtimeMs || after.size !== before.size));
      const isFreshEnough = after.mtimeMs >= startedAtMs - 1000;

      if ((wasCreated && isFreshEnough) || wasUpdated) {
        return candidate;
      }
    }

    return null;
  }

  private static getFinalMarkdownPath(pdfPath: string, outputDir: string): string {
    const pdfStem = path.basename(pdfPath, path.extname(pdfPath));
    return path.join(outputDir, `${pdfStem.replace(/\s+/g, "_")}.md`);
  }

  private static toSafeAsciiName(name: string): string {
    const ascii = name
      .normalize("NFKD")
      .replace(/[^\x20-\x7E]/g, "")
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "");
    return ascii || "document";
  }

  private static cleanFormulaContext(context: string): string {
    return context
      .replace(/!\[[^\]]*\]\(data:image\/[^)]+\)/g, "[embedded image omitted]")
      .replace(/<!--\s*formula-not-decoded\s*-->/gi, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 260);
  }

  private static writeFormulaAudit(markdownPath: string, pdfPath: string, entries: FormulaAuditEntry[]): void {
    if (entries.length === 0) return;

    const outputDir = path.dirname(markdownPath);
    const auditDir = path.join(outputDir, "Formula-Audits");
    const mdStem = path.basename(markdownPath, path.extname(markdownPath));
    const auditPath = path.join(auditDir, `${mdStem} Formula Audit.md`);

    fs.mkdirSync(auditDir, { recursive: true });
    const auditContent = [
      `# ${mdStem} Formula Audit`,
      "",
      `Source PDF: ${path.basename(pdfPath)}`,
      `Source Markdown: [[${mdStem}]]`,
      `Undecoded formulas: ${entries.length}`,
      "",
      "> [!TIP]",
      "> 这个清单用于辅助知识库建设，不要求逐条追求 PDF 100% 还原。只修会影响理解、考试规则或核心算法的公式。",
      "",
      "## 待修公式清单",
      "",
      ...entries.map(entry => [
        `### ${entry.id}`,
        "",
        `- 上下文：${entry.context || "(no nearby text captured)"}`,
        "- 状态：待修复",
        "- 建议：优先手动补 LaTeX；只有复杂图形/大段推导才考虑截图保真。",
        "- LaTeX 补写：",
        "```latex",
        "",
        "```",
        "",
      ].join("\n")),
    ].join("\n");

    fs.writeFileSync(auditPath, auditContent, "utf8");
  }

  private static annotateUndecodedFormulas(markdownPath: string, pdfPath: string): number {
    if (!fs.existsSync(markdownPath)) return 0;

    const content = fs.readFileSync(markdownPath, "utf8");
    let index = 0;
    const sourcePdfName = path.basename(pdfPath);
    const entries: FormulaAuditEntry[] = [];
    const formulaPattern = /<!--\s*formula-not-decoded\s*-->/gi;
    const annotated = content.replace(formulaPattern, (match, offset) => {
      index += 1;
      const formulaId = `formula-${String(index).padStart(3, "0")}`;
      const before = content.slice(Math.max(0, offset - 420), offset);
      const after = content.slice(offset + match.length, offset + match.length + 420);
      entries.push({
        id: formulaId,
        context: this.cleanFormulaContext(`${before} ${after}`),
      });

      return [
        `> [!warning] Formula not decoded (${formulaId})`,
        `> Docling detected a formula here but could not convert it to LaTeX.`,
        `> Source PDF: [[${sourcePdfName}]]`,
        `> Nearby text: ${entries[entries.length - 1].context || "(no nearby text captured)"}`,
        `> Audit: [[Formula-Audits/${path.basename(markdownPath, path.extname(markdownPath))} Formula Audit#${formulaId}|${formulaId}]]`,
        `> Page: 待定位`,
        `> Fix slot:`,
        `> \`\`\`latex`,
        `> `,
        `> \`\`\``,
      ].join("\n");
    });

    if (index > 0 && annotated !== content) {
      fs.writeFileSync(markdownPath, annotated, "utf8");
      this.writeFormulaAudit(markdownPath, pdfPath, entries);
    }

    return index;
  }

  private static isPythonDoclingCommand(doclingCommand: string): boolean {
    return doclingCommand.includes("python -m docling") || doclingCommand.startsWith("python") || doclingCommand.includes("docling.cli");
  }

  private static buildDoclingInvocation(
    pdfPath: string,
    outputDir: string,
    doclingCommand: string,
    pythonPath: string
  ): { cmd: string; args: string[] } {
    if (this.isPythonDoclingCommand(doclingCommand)) {
      return {
        cmd: pythonPath || "python",
        args: ["-m", "docling.cli.main", pdfPath, "--to", "md", "--output", outputDir],
      };
    }

    return {
      cmd: doclingCommand,
      args: [pdfPath, "--to", "md", "--output", outputDir],
    };
  }

  private static runProcess(
    cmd: string,
    args: string[],
    onProgress: (data: string) => void
  ): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { shell: false });
      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data) => {
        const text = data.toString();
        stdout += text;
        onProgress(text);
      });

      child.stderr.on("data", (data) => {
        const text = data.toString();
        stderr += text;
        onProgress(`[stderr] ${text}`);
      });

      child.on("error", (err) => {
        onProgress(`Process spawn error: ${err.message}\n`);
        reject(err);
      });

      child.on("close", (code) => {
        resolve({
          code,
          stdout,
          stderr,
          output: `${stdout}\n${stderr}`.trim(),
        });
      });
    });
  }

  private static async runDoclingAttempt(
    pdfPath: string,
    outputDir: string,
    doclingCommand: string,
    pythonPath: string,
    onProgress: (data: string) => void,
    annotateFormulas = true
  ): Promise<string> {
    fs.mkdirSync(outputDir, { recursive: true });

    const startedAtMs = Date.now();
    const expectedMarkdownFiles = this.getExpectedMarkdownCandidates(pdfPath, outputDir);
    const beforeSnapshots = new Map(
      expectedMarkdownFiles.map((candidate) => [candidate, this.getFileSnapshot(candidate)] as [string, FileSnapshot | null])
    );
    const { cmd, args } = this.buildDoclingInvocation(pdfPath, outputDir, doclingCommand, pythonPath);

    onProgress(`Spawning conversion: ${cmd} ${args.join(" ")}\n`);
    const result = await this.runProcess(cmd, args, onProgress);
    const generatedMarkdown = this.findGeneratedMarkdown(pdfPath, outputDir, startedAtMs, beforeSnapshots);

    if (result.code === 0 && generatedMarkdown) {
      if (!annotateFormulas) {
        return generatedMarkdown;
      }

      const formulaCount = this.annotateUndecodedFormulas(generatedMarkdown, pdfPath);
      if (formulaCount > 0) {
        onProgress(`Annotated ${formulaCount} undecoded formula placeholders in ${path.basename(generatedMarkdown)}.\n`);
      }
      return generatedMarkdown;
    }

    const expectedList = expectedMarkdownFiles.map((filePath) => path.basename(filePath)).join(" or ");
    const exitDetail = result.code === 0
      ? "Docling exited with code 0 but did not create or update the expected Markdown output"
      : `Docling process exited with code ${result.code}`;
    const error = new Error(`${exitDetail}. Expected non-empty output: ${expectedList}`) as Error & { processOutput?: string };
    error.processOutput = result.output;
    throw error;
  }

  private static getPdfSplitScript(): string {
    return `
import json
import os
import sys

pdf_path = sys.argv[1]
output_dir = sys.argv[2]
chunk_size = max(1, int(sys.argv[3]))

try:
    from pypdf import PdfReader, PdfWriter
except Exception:
    try:
        from PyPDF2 import PdfReader, PdfWriter
    except Exception as exc:
        raise SystemExit("Missing pypdf/PyPDF2. Install one of them in the Docling Python environment. " + str(exc))

reader = PdfReader(pdf_path)
total_pages = len(reader.pages)
os.makedirs(output_dir, exist_ok=True)
chunks = []

for start in range(0, total_pages, chunk_size):
    end = min(start + chunk_size, total_pages)
    writer = PdfWriter()
    for page_index in range(start, end):
        writer.add_page(reader.pages[page_index])
    chunk_name = f"part_{start + 1:04d}_{end:04d}.pdf"
    chunk_path = os.path.join(output_dir, chunk_name)
    with open(chunk_path, "wb") as handle:
        writer.write(handle)
    chunks.append({"path": chunk_path, "start": start + 1, "end": end})

print(json.dumps({"totalPages": total_pages, "chunks": chunks}, ensure_ascii=False))
`;
  }

  private static parseSplitPlan(stdout: string): PdfSplitPlan {
    const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]) as PdfSplitPlan;
        if (Array.isArray(parsed.chunks)) {
          return parsed;
        }
      } catch {
        // Keep scanning previous lines because Python warnings may precede JSON.
      }
    }

    throw new Error("Could not parse PDF split plan from Python output.");
  }

  private static async splitPdfIntoChunks(
    pdfPath: string,
    tempPdfDir: string,
    pythonPath: string,
    onProgress: (data: string) => void
  ): Promise<PdfSplitPlan> {
    const pyExe = pythonPath || "python";
    const args = ["-c", this.getPdfSplitScript(), pdfPath, tempPdfDir, String(this.SEGMENT_PAGE_SIZE)];
    onProgress(`Splitting PDF into ${this.SEGMENT_PAGE_SIZE}-page chunks: ${path.basename(pdfPath)}\n`);
    const result = await this.runProcess(pyExe, args, onProgress);

    if (result.code !== 0) {
      throw new Error(`PDF split failed with code ${result.code}. ${result.stderr || result.stdout}`);
    }

    return this.parseSplitPlan(result.stdout);
  }

  private static async convertPdfInSegments(
    pdfPath: string,
    outputDir: string,
    doclingCommand: string,
    pythonPath: string,
    onProgress: (data: string) => void
  ): Promise<string> {
    const pdfStem = path.basename(pdfPath, path.extname(pdfPath));
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), this.TEMP_PREFIX));
    const tempDir = path.join(tempRoot, `${this.toSafeAsciiName(pdfStem)}-${Date.now()}`);
    const tempPdfDir = path.join(tempDir, "pdf");
    const tempMdDir = path.join(tempDir, "md");
    const finalMarkdownPath = this.getFinalMarkdownPath(pdfPath, outputDir);

    fs.mkdirSync(tempPdfDir, { recursive: true });
    fs.mkdirSync(tempMdDir, { recursive: true });

    try {
      const splitPlan = await this.splitPdfIntoChunks(pdfPath, tempPdfDir, pythonPath, onProgress);
      if (splitPlan.chunks.length === 0) {
        throw new Error("PDF split produced no chunks.");
      }

      onProgress(`Segmented fallback created ${splitPlan.chunks.length} chunks for ${splitPlan.totalPages} pages.\n`);

      const mergedParts: string[] = [
        `# ${pdfStem}`,
        "",
        `> Generated by Scriptorium segmented Docling fallback from ${path.basename(pdfPath)}.`,
        `> Source pages: ${splitPlan.totalPages}. Chunk size: ${this.SEGMENT_PAGE_SIZE} pages.`,
        "",
      ];

      for (let index = 0; index < splitPlan.chunks.length; index++) {
        const chunk = splitPlan.chunks[index];
        onProgress(`\n--- Segment ${index + 1}/${splitPlan.chunks.length}: pages ${chunk.start}-${chunk.end} ---\n`);
        if (!fs.existsSync(chunk.path)) {
          throw new Error(`PDF segment was not found before Docling conversion: ${chunk.path}`);
        }
        const chunkMarkdownPath = await this.runDoclingAttempt(
          chunk.path,
          tempMdDir,
          doclingCommand,
          pythonPath,
          onProgress,
          false
        );
        const chunkMarkdown = fs.readFileSync(chunkMarkdownPath, "utf8").trim();
        mergedParts.push(`## Pages ${chunk.start}-${chunk.end}`, "", chunkMarkdown, "");
      }

      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(finalMarkdownPath, mergedParts.join("\n"), "utf8");
      const formulaCount = this.annotateUndecodedFormulas(finalMarkdownPath, pdfPath);
      if (formulaCount > 0) {
        onProgress(`Annotated ${formulaCount} undecoded formula placeholders in ${path.basename(finalMarkdownPath)}.\n`);
      }
      onProgress(`\nSegmented Markdown merged: ${finalMarkdownPath}\n`);
      fs.rmSync(tempRoot, { recursive: true, force: true });
      return finalMarkdownPath;
    } catch (err) {
      onProgress(`Segmented fallback temp files kept for diagnosis: ${tempRoot}\n`);
      throw err;
    }
  }

  /**
   * Helper to locate python on Windows.
   */
  static findPythonOnWindows(): string | null {
    if (process.platform !== "win32") return null;

    const commonPaths = [
      "C:\\Python313\\python.exe",
      "C:\\Python312\\python.exe",
      "C:\\Python311\\python.exe",
      "C:\\Python310\\python.exe",
    ];

    // Check AppData local programs
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      const programsPythonDir = path.join(localAppData, "Programs", "Python");
      if (fs.existsSync(programsPythonDir)) {
        try {
          const versions = fs.readdirSync(programsPythonDir);
          for (const ver of versions) {
            const fullPath = path.join(programsPythonDir, ver, "python.exe");
            if (fs.existsSync(fullPath)) {
              commonPaths.push(fullPath);
            }
          }
        } catch (e) {
          // ignore
        }
      }
    }

    for (const p of commonPaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    return null;
  }

  /**
   * Checks if Docling and Python environments are available and configured correctly.
   */
  static async checkEnvironment(doclingCommand: string, pythonPath: string): Promise<{ success: boolean; error?: string; resolvedPythonPath?: string }> {
    try {
      // 1. If user uses python -m docling, test python import
      if (this.isPythonDoclingCommand(doclingCommand)) {
        let pyExe = pythonPath || "python";
        
        // Try direct run
        try {
          execSync(`"${pyExe}" -c "import docling"`, { stdio: "ignore" });
          return { success: true, resolvedPythonPath: pyExe };
        } catch (err: any) {
          // If the default path fails and we are on Windows, try to auto-detect python.exe
          if (pyExe === "python" && process.platform === "win32") {
            const autoPath = this.findPythonOnWindows();
            if (autoPath) {
              try {
                execSync(`"${autoPath}" -c "import docling"`, { stdio: "ignore" });
                return { success: true, resolvedPythonPath: autoPath };
              } catch (fallbackErr: any) {
                const fallbackStderr = fallbackErr.stderr ? fallbackErr.stderr.toString().trim() : "";
                return {
                  success: false,
                  error: `Found python at '${autoPath}', but running 'import docling' failed.\nError: ${fallbackStderr || fallbackErr.message || fallbackErr}\n\nPlease install docling under that Python environment.`
                };
              }
            }
          }

          const stderr = err.stderr ? err.stderr.toString().trim() : "";
          return { 
            success: false, 
            error: `Python environment check failed using: "${pyExe}" -c "import docling"\nError: ${stderr || err.message || err}\n\nTips:\n1. Make sure Python is installed and docling is installed via pip.\n2. Configure the absolute path to your python.exe (e.g. C:\\Python313\\python.exe) in plugin settings.` 
          };
        }
      }

      // 2. Otherwise, check standard docling executable
      try {
        execSync(`${doclingCommand} --help`, { stdio: "ignore" });
        return { success: true, resolvedPythonPath: pythonPath };
      } catch (err: any) {
        // Fallback check: if docling command itself fails, let's see if we can find python and run it as a module fallback
        if (process.platform === "win32") {
          const autoPath = this.findPythonOnWindows();
          if (autoPath) {
            try {
              execSync(`"${autoPath}" -c "import docling"`, { stdio: "ignore" });
              return { success: true, resolvedPythonPath: autoPath };
            } catch (e) {
              // ignore and report original error
            }
          }
        }

        const stderr = err.stderr ? err.stderr.toString().trim() : "";
        return { 
          success: false, 
          error: `Docling command '${doclingCommand}' not found or failed.\nError: ${stderr || err.message || err}\n\nTips:\nConfigure 'python -m docling.cli.main' and set your custom pythonPath in settings.` 
        };
      }
    } catch (globalErr: any) {
      return { 
        success: false, 
        error: `Environment check failed: ${globalErr.message || globalErr}` 
      };
    }
  }

  /**
   * Converts a PDF file to Markdown using Docling.
   * Emits console outputs via the onProgress callback in real-time.
   */
  static convertPdf(
    pdfPath: string, 
    outputDir: string, 
    doclingCommand: string, 
    pythonPath: string,
    onProgress: (data: string) => void
  ): Promise<void> {
    return this.runDoclingAttempt(pdfPath, outputDir, doclingCommand, pythonPath, onProgress)
      .then((generatedMarkdown) => {
        onProgress(`\n✨ Successfully converted: ${path.basename(pdfPath)}\n`);
        onProgress(`Output verified: ${generatedMarkdown}\n`);
      })
      .catch(async (firstError: Error) => {
        onProgress(`\n⚠️ Direct Docling conversion failed: ${firstError.message}\n`);
        onProgress(`Attempting segmented fallback to avoid large-PDF memory pressure...\n`);

        const generatedMarkdown = await this.convertPdfInSegments(
          pdfPath,
          outputDir,
          doclingCommand,
          pythonPath,
          onProgress
        );

        onProgress(`\n✨ Successfully converted with segmented fallback: ${path.basename(pdfPath)}\n`);
        onProgress(`Output verified: ${generatedMarkdown}\n`);
      });
  }
}
